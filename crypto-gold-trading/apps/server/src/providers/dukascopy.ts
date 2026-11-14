/**
 * Dukascopy historical data feed (keyless, static files). Genuine bank price history for
 * spot gold (XAUUSD), spot silver (XAGUSD) and FX majors.
 *
 * File layout (all times UTC, LZMA "alone" compressed, big-endian):
 *   {inst}/{year}/BID_candles_day_1.bi5                 daily candles for a completed year
 *   {inst}/{year}/{month0}/BID_candles_hour_1.bi5       hourly candles for a completed month
 *   {inst}/{year}/{month0}/{day}/BID_candles_min_1.bi5  minute candles for a completed day
 *   {inst}/{year}/{month0}/{day}/{HH}h_ticks.bi5        ticks for a completed hour
 * Candle record (24 B): time offset s, open, close, low, high (int32 × decimals), volume f32.
 * Tick record (20 B): time offset ms, ask, bid (int32 × decimals), askVol f32, bidVol f32.
 * Completed-period files are immutable and are cached on disk as decoded JSON.
 *
 * The archive limits how much one address may download, so the client never hammers it:
 *  - at most three downloads at a time (two of them FX, which is background work), spaced out,
 *    gold before silver and the newest files first;
 *  - a file that failed is left alone for 30 s, then 1, 2, 4, 8 and at most 10 minutes;
 *  - when failures cluster, every download is paused for a cool-down and then resumed one at a time
 *    and at half the previous pace; the pace speeds up again only gradually while downloads succeed.
 *    If nothing at all succeeds between two pauses (an outage), the pause doubles, up to 10 minutes;
 *  - failures are reported as a few summary lines, not once per file.
 */
import fs from "node:fs/promises";
import path from "node:path";
import lzma from "lzma";
import type { Candle } from "@terminal/core";
import { config } from "../config";
import { logger } from "../lib/logger";
import { isSpotMarketOpen } from "./swissquote";

const BASE = "https://datafeed.dukascopy.com/datafeed";
const UA = "CryptoGoldTerminal/0.2 (research; dukascopy historical feed)";
/**
 * Price scaling per instrument (verified against the archive: EUR/USD 117455 → 1.17455, USD/JPY 156658 → 156.658,
 * XAU/USD 3874585 → 3874.585, XAG/USD 49074 → 49.074). The metals service also compares every series it
 * builds with the live quote, so a wrong scale could never reach a chart.
 */
export const DECIMALS: Record<string, number> = { XAUUSD: 1000, XAGUSD: 1000, EURUSD: 100000, GBPUSD: 100000, USDCAD: 100000, USDSEK: 100000, USDCHF: 100000, USDJPY: 1000 };
const DAY = 86_400_000;
const HOUR = 3_600_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The archive answered with a status other than 200 or 404 (typically 503 when it is limiting downloads). */
export class ArchiveHttpError extends Error {
  constructor(
    readonly status: number,
    relPath: string,
    /** The archive's own "Retry-After" hint, when it sent one. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(`Dukascopy HTTP ${status} for ${relPath}`);
    this.name = "ArchiveHttpError";
  }
}

/** A file cannot be had right now: its download failed, it is waiting for its next try, or the archive is paused. */
export class ArchiveMiss extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveMiss";
  }
}

function lzmaDecompress(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    lzma.decompress(buf, (result: number[] | string, error?: Error) => {
      if (error) return reject(error);
      if (typeof result === "string") return resolve(Buffer.from(result, "binary"));
      resolve(Buffer.from(Uint8Array.from(result, (b) => b & 0xff)));
    });
  });
}

/** Downloads one archive file. Resolves null for 404 (not published). */
export async function fetchArchiveFile(relPath: string, timeoutMs: number): Promise<Buffer | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/${relPath}`, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (res.status === 404) return null;
    if (!res.ok) {
      const retryAfter = Number.parseFloat(res.headers.get("retry-after") ?? "");
      throw new ArchiveHttpError(res.status, relPath, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3600) * 1000 : null);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length < 20 ? null : buf;
  } finally {
    clearTimeout(timer);
  }
}

async function decode(buf: Buffer, kind: "candles" | "ticks", baseTime: number, decimals: number): Promise<Candle[]> {
  const raw = await lzmaDecompress(buf);
  return kind === "candles" ? decodeCandles(raw, baseTime, decimals) : decodeTicksToMinutes(raw, baseTime, decimals);
}

export function decodeCandles(buf: Buffer, baseTime: number, decimals: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + 24 <= buf.length; i += 24) {
    const t = baseTime + buf.readInt32BE(i) * 1000;
    const open = buf.readInt32BE(i + 4) / decimals;
    const close = buf.readInt32BE(i + 8) / decimals;
    const low = buf.readInt32BE(i + 12) / decimals;
    const high = buf.readInt32BE(i + 16) / decimals;
    const volume = buf.readFloatBE(i + 20);
    if (!(open > 0 && close > 0 && low > 0 && high > 0)) continue;
    // Flat zero-volume bars are closed-market filler; drop them so sessions show real gaps.
    if (volume === 0 && open === close && close === low && low === high) continue;
    out.push({ time: t, open, high, low, close, volume });
  }
  return out;
}

export function decodeTicksToMinutes(buf: Buffer, baseTime: number, decimals: number): Candle[] {
  const byMinute = new Map<number, Candle>();
  for (let i = 0; i + 20 <= buf.length; i += 20) {
    const t = baseTime + buf.readInt32BE(i);
    const ask = buf.readInt32BE(i + 4) / decimals;
    const bid = buf.readInt32BE(i + 8) / decimals;
    const vol = buf.readFloatBE(i + 16);
    if (!(bid > 0) || !(ask > 0)) continue;
    const m = Math.floor(t / 60_000) * 60_000;
    const c = byMinute.get(m);
    if (!c) byMinute.set(m, { time: m, open: bid, high: bid, low: bid, close: bid, volume: vol || 1 });
    else {
      c.high = Math.max(c.high, bid);
      c.low = Math.min(c.low, bid);
      c.close = bid;
      c.volume += vol || 1;
    }
  }
  return [...byMinute.values()].sort((a, b) => a.time - b.time);
}

export interface ArchiveOptions {
  /** Directory for decoded immutable files; null disables the disk cache (tests). */
  cacheDir?: string | null;
  /** Downloads one file: the bytes, or null when the archive answers 404 (not published). */
  fetchFile?: (relPath: string, timeoutMs: number) => Promise<Buffer | null>;
  log?: { debug: (m: string) => void; info: (m: string) => void; warn: (m: string) => void };
  /** Uniform random in [0, 1) for jitter. */
  random?: () => number;
  /** Simultaneous downloads overall, and how many of them may be background (FX, not a metal) files. */
  concurrency?: number;
  backgroundConcurrency?: number;
  /** Normal spacing between download starts; it doubles (up to `maxIntervalMs`) each time the archive refuses. */
  minIntervalMs?: number;
  backgroundIntervalMs?: number;
  maxIntervalMs?: number;
  requestTimeoutMs?: number;
  /** One quick second try after a dropped connection (never after an HTTP error or a timeout). */
  networkRetryDelayMs?: number;
  /** A failed file is left alone for base × 2^(failures − 1), capped at max. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** This many failures inside the window pause every download. The cool-down doubles only when nothing succeeded since the last pause. */
  breakerFailures?: number;
  breakerWindowMs?: number;
  coolDownBaseMs?: number;
  coolDownMaxMs?: number;
  /** After a pause downloads run one at a time until this many succeed in a row. */
  recoverySuccesses?: number;
}

export interface SeriesBuild {
  candles: Candle[];
  /** Files that could not be loaded this time (a "not published" 404 does not count). */
  missing: number;
}

export interface ArchiveClassProgress {
  /** Distinct files that had to come from the network since start. */
  total: number;
  done: number;
  /** Files whose last download failed and that are waiting for their next try. */
  failing: number;
}

export interface ArchiveProgress {
  gold: ArchiveClassProgress;
  silver: ArchiveClassProgress;
  /** FX files for the dollar index. */
  other: ArchiveClassProgress;
  active: number;
  queued: number;
  /** "paused": the archive was refusing downloads, nothing is requested until `resumesAt`. */
  state: "ok" | "paused" | "recovering";
  resumesAt: number | null;
  nextRetryAt: number | null;
}

type FileClass = "gold" | "silver" | "other";
const FILE_CLASSES: FileClass[] = ["gold", "silver", "other"];

function classOf(instrument: string): FileClass {
  return instrument === "XAUUSD" ? "gold" : instrument === "XAGUSD" ? "silver" : "other";
}
interface Waiter {
  resolve: () => void;
  priority: number;
  background: boolean;
  seq: number;
}

const fmtDuration = (ms: number) => (ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/** A dropped connection that is worth one immediate second try (not an HTTP error, not a timeout). */
function isDroppedConnection(err: unknown): boolean {
  if (err instanceof ArchiveHttpError) return false;
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return false;
  return /fetch failed|ECONNRESET|EAI_AGAIN|ENOTFOUND|EPIPE|socket|terminated|other side closed/i.test(`${e?.message ?? ""} ${e?.cause?.code ?? ""}`);
}

export class DukascopyClient {
  private readonly o: Required<Omit<ArchiveOptions, "cacheDir">> & { cacheDir: string | null };
  private inflight = new Map<string, Promise<Candle[] | null>>();
  private memo = new Map<string, { at: number; value: Candle[] | null }>();
  /** Files whose last download failed: when they may be tried again. */
  private failing = new Map<string, { failures: number; retryAt: number; message: string }>();
  private needed: Record<FileClass, Set<string>> = { gold: new Set(), silver: new Set(), other: new Set() };
  private completed: Record<FileClass, Set<string>> = { gold: new Set(), silver: new Set(), other: new Set() };
  private active = 0;
  private activeBackground = 0;
  private seq = 0;
  private queue: Waiter[] = [];
  private nextStartAt = 0;
  private recentFailures: number[] = [];
  private state: "ok" | "paused" | "recovering" = "ok";
  private pausedUntil = 0;
  private trips = 0;
  private recoveryStreak = 0;
  private successStreak = 0;
  /** Current spacing between download starts (adaptive: slower after refusals, faster after sustained success). */
  private pace: number;
  private successesSincePause = 0;
  private pausesWithoutProgress = 0;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private hadOutstanding = false;
  private lastStillRefusingLog = 0;
  /** Network activity since start (cache hits are not counted). */
  readonly stats = { downloaded: 0, failedAttempts: 0 };

  constructor(options: ArchiveOptions = {}) {
    this.o = {
      cacheDir: options.cacheDir === undefined ? path.join(config.dataDir, "cache", "dukascopy") : options.cacheDir,
      fetchFile: options.fetchFile ?? fetchArchiveFile,
      log: options.log ?? logger("dukascopy"),
      random: options.random ?? Math.random,
      concurrency: options.concurrency ?? 3,
      backgroundConcurrency: options.backgroundConcurrency ?? 2,
      minIntervalMs: options.minIntervalMs ?? 150,
      backgroundIntervalMs: options.backgroundIntervalMs ?? 350,
      maxIntervalMs: options.maxIntervalMs ?? 5_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      networkRetryDelayMs: options.networkRetryDelayMs ?? 2_000,
      backoffBaseMs: options.backoffBaseMs ?? 30_000,
      backoffMaxMs: options.backoffMaxMs ?? 10 * 60_000,
      breakerFailures: options.breakerFailures ?? 5,
      breakerWindowMs: options.breakerWindowMs ?? 30_000,
      coolDownBaseMs: options.coolDownBaseMs ?? 60_000,
      coolDownMaxMs: options.coolDownMaxMs ?? 10 * 60_000,
      recoverySuccesses: options.recoverySuccesses ?? 3,
    };
    this.pace = this.o.minIntervalMs;
  }

  /** Download state for the first-start display: how many files are needed, done and waiting to be retried. */
  progress(): ArchiveProgress {
    const failing: Record<FileClass, number> = { gold: 0, silver: 0, other: 0 };
    for (const key of this.failing.keys()) failing[classOf(key.slice(0, key.indexOf("/")))]++;
    const count = (cls: FileClass): ArchiveClassProgress => ({ total: this.needed[cls].size, done: this.completed[cls].size, failing: failing[cls] });
    let nextRetryAt: number | null = null;
    for (const f of this.failing.values()) nextRetryAt = nextRetryAt === null ? f.retryAt : Math.min(nextRetryAt, f.retryAt);
    const [gold, silver, other] = FILE_CLASSES.map(count);
    return { gold, silver, other, active: this.active, queued: this.queue.length, state: this.state, resumesAt: this.state === "paused" ? this.pausedUntil : null, nextRetryAt };
  }

  /** Stops timers (tests and shutdown). */
  dispose() {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }

  /**
   * Order matters on a machine with an empty cache: the metals before FX, and recent files (the quote,
   * intraday charts) before old ones. Within each kind of file gold goes first and silver follows, so
   * both prices and intraday charts are in before either metal's deep history. Higher priority runs
   * first; equal priority is first come, first served.
   */
  private priorityOf(instrument: string, relPath: string, periodEnd: number): number {
    const kind = relPath.includes("min_1") || relPath.includes("ticks") ? 30 : relPath.includes("hour_1") ? 20 : 10;
    const ageDays = Math.min(3650, Math.max(0, (Date.now() - periodEnd) / DAY));
    const cls = classOf(instrument);
    return (cls === "other" ? 0 : 100) + kind + (cls === "gold" ? 5 : 0) - ageDays / 10_000;
  }

  private hasCapacity(background: boolean): boolean {
    if (this.state === "recovering") return this.active < 1; // one at a time until the archive proves healthy
    if (this.active >= this.o.concurrency) return false;
    return !background || this.activeBackground < this.o.backgroundConcurrency;
  }

  /** Hands free capacity to the best eligible waiters. */
  private pump() {
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const w = this.queue[i];
        if (!this.hasCapacity(w.background)) continue;
        if (best < 0 || w.priority > this.queue[best].priority || (w.priority === this.queue[best].priority && w.seq < this.queue[best].seq)) best = i;
      }
      if (best < 0) return;
      const [w] = this.queue.splice(best, 1);
      this.active++;
      if (w.background) this.activeBackground++;
      w.resolve();
    }
  }

  private async limit<T>(priority: number, background: boolean, fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.queue.push({ resolve, priority, background, seq: this.seq++ });
      this.pump();
    });
    try {
      // Paused while this file was waiting for a slot: give the slot back at once instead of pacing first.
      if (this.pausedUntil > Date.now()) throw new ArchiveMiss("archive downloads are paused");
      // Space download starts out so the archive never sees a burst.
      const now = Date.now();
      const startAt = Math.max(now, this.nextStartAt);
      this.nextStartAt = startAt + Math.max(this.pace, background ? this.o.backgroundIntervalMs : 0);
      if (startAt > now) await sleep(startAt - now);
      return await fn();
    } finally {
      this.active--;
      if (background) this.activeBackground--;
      this.pump();
    }
  }

  private async fetchWithOneRetry(relPath: string): Promise<Buffer | null> {
    try {
      return await this.o.fetchFile(relPath, this.o.requestTimeoutMs);
    } catch (err) {
      if (!isDroppedConnection(err)) throw err;
      await sleep(this.o.networkRetryDelayMs * (0.75 + 0.5 * this.o.random()));
      if (this.pausedUntil > Date.now()) throw err;
      return this.o.fetchFile(relPath, this.o.requestTimeoutMs);
    }
  }

  private onSuccess(key: string) {
    this.stats.downloaded++;
    this.failing.delete(key);
    this.successStreak++;
    this.successesSincePause++;
    // Speed up again only gradually: 20 % faster after every ten downloads in a row that worked.
    if (this.successStreak % 10 === 0) this.pace = Math.max(this.o.minIntervalMs, this.pace * 0.8);
    if (this.state === "recovering" && ++this.recoveryStreak >= this.o.recoverySuccesses) {
      this.state = "ok";
      this.o.log.info("archive downloads are back to normal");
    }
    if (this.hadOutstanding && this.failing.size === 0) {
      this.hadOutstanding = false;
      this.trips = 0; // the episode is over: the next refusal is announced again
      this.o.log.info("archive: every file that had failed has now been downloaded");
    }
  }

  private onFailure(key: string, err: Error) {
    const now = Date.now();
    this.stats.failedAttempts++;
    this.successStreak = 0;
    const failures = (this.failing.get(key)?.failures ?? 0) + 1;
    const backoff = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** (failures - 1)) * (0.85 + 0.3 * this.o.random());
    this.failing.set(key, { failures, retryAt: now + backoff, message: err.message });
    this.hadOutstanding = true;
    this.o.log.debug(`download failed (attempt ${failures}), next try in ${fmtDuration(backoff)}: ${err.message}`);
    this.recentFailures = this.recentFailures.filter((t) => now - t < this.o.breakerWindowMs);
    this.recentFailures.push(now);
    if (this.state === "recovering" || this.recentFailures.length >= this.o.breakerFailures) this.pause(now, err instanceof ArchiveHttpError ? err.retryAfterMs : null);
  }

  /** The archive is refusing or dropping downloads: stop asking for a while instead of making it worse. */
  private pause(now: number, retryAfterMs: number | null = null) {
    if (this.state === "paused") return;
    // Refused although some downloads worked since the last pause: the archive is limiting, so slow down.
    // Nothing worked at all: it is down or blocking, so wait longer each time.
    this.pausesWithoutProgress = this.trips > 0 && this.successesSincePause === 0 ? this.pausesWithoutProgress + 1 : 0;
    this.trips++;
    this.successesSincePause = 0;
    this.pace = Math.min(this.o.maxIntervalMs, Math.max(this.pace, 250) * 2);
    const coolDown = Math.max(Math.min(this.o.coolDownMaxMs, this.o.coolDownBaseMs * 2 ** this.pausesWithoutProgress), retryAfterMs ?? 0);
    this.state = "paused";
    this.pausedUntil = now + coolDown;
    this.recentFailures = [];
    this.recoveryStreak = 0;
    const outstanding = `${this.failing.size} file${this.failing.size === 1 ? "" : "s"} outstanding, retried automatically`;
    if (this.trips === 1) this.o.log.warn(`the archive is refusing or dropping downloads; pausing all archive downloads for ${fmtDuration(coolDown)} (${outstanding})`);
    else if (now - this.lastStillRefusingLog > 30 * 60_000) {
      this.lastStillRefusingLog = now;
      this.o.log.info(`the archive is still refusing downloads; next try in ${fmtDuration(coolDown)} (${outstanding})`);
    } else this.o.log.debug(`archive paused again for ${fmtDuration(coolDown)}`);
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.state = "recovering";
      this.pausedUntil = 0;
      this.pump();
    }, coolDown);
    (this.resumeTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Load one archive file as candles. Immutable (completed) periods are cached on disk forever.
   * Rejects with ArchiveMiss when the file cannot be had right now: its download failed, it is waiting
   * for its next try, or the archive is paused. Nothing is requested from the network in the last two cases.
   */
  async load(instrument: string, relPath: string, baseTime: number, kind: "candles" | "ticks", immutable: boolean, periodEnd = baseTime): Promise<Candle[] | null> {
    const key = `${instrument}/${relPath}`;
    const memo = this.memo.get(key);
    // A completed period never changes once published, but a 404 can mean "not published yet": retry recent ones after
    // 10 minutes, older ones after 6 hours (a missing file for a long-completed period is a real gap, e.g. a holiday).
    const nullTtl = periodEnd > Date.now() - 3 * HOUR ? 10 * 60_000 : 6 * HOUR;
    if (memo && ((immutable && memo.value !== null) || Date.now() - memo.at < (memo.value === null ? nullTtl : 5 * 60_000))) return memo.value;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      const file = this.o.cacheDir ? path.join(this.o.cacheDir, instrument, relPath.replace(/\//g, "_") + ".json") : null;
      if (immutable && file) {
        try {
          const cached = JSON.parse(await fs.readFile(file, "utf8")) as { candles: Candle[] | null };
          this.memo.set(key, { at: Date.now(), value: cached.candles });
          return cached.candles;
        } catch {
          /* not cached */
        }
      }
      const cls = classOf(instrument);
      this.needed[cls].add(key);
      const failed = this.failing.get(key);
      if (failed && Date.now() < failed.retryAt) throw new ArchiveMiss(failed.message);
      if (this.pausedUntil > Date.now()) throw new ArchiveMiss("archive downloads are paused");
      const value = await this.limit(this.priorityOf(instrument, relPath, periodEnd), cls === "other", async () => {
        if (this.pausedUntil > Date.now()) throw new ArchiveMiss("archive downloads are paused");
        try {
          const buf = await this.fetchWithOneRetry(`${instrument}/${relPath}`);
          const candles = buf ? await decode(buf, kind, baseTime, DECIMALS[instrument] ?? 1000) : null;
          this.onSuccess(key);
          return candles;
        } catch (err) {
          this.onFailure(key, err as Error);
          throw new ArchiveMiss((err as Error).message);
        }
      });
      this.memo.set(key, { at: Date.now(), value });
      this.completed[cls].add(key);
      // Persist decoded immutable files; a 404 is persisted only once the period is comfortably in the past.
      if (immutable && file && (value !== null || periodEnd < Date.now() - 3 * DAY)) {
        try {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, JSON.stringify({ candles: value }));
        } catch (err) {
          this.o.log.warn(`cache write failed: ${(err as Error).message}`);
        }
      }
      return value;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  dayFile(instrument: string, year: number, now: number) {
    return this.load(instrument, `${year}/BID_candles_day_1.bi5`, Date.UTC(year, 0, 1), "candles", year < new Date(now).getUTCFullYear(), Date.UTC(year + 1, 0, 1));
  }
  monthHourFile(instrument: string, year: number, month0: number, now: number) {
    const d = new Date(now);
    const immutable = year < d.getUTCFullYear() || (year === d.getUTCFullYear() && month0 < d.getUTCMonth());
    return this.load(instrument, `${year}/${String(month0).padStart(2, "0")}/BID_candles_hour_1.bi5`, Date.UTC(year, month0, 1), "candles", immutable, Date.UTC(year, month0 + 1, 1));
  }
  dayMinuteFile(instrument: string, dayStart: number, now: number) {
    const d = new Date(dayStart);
    return this.load(instrument, `${d.getUTCFullYear()}/${String(d.getUTCMonth()).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/BID_candles_min_1.bi5`, dayStart, "candles", dayStart + DAY < now - HOUR, dayStart + DAY);
  }
  hourTickFile(instrument: string, hourStart: number, now: number) {
    const d = new Date(hourStart);
    return this.load(instrument, `${d.getUTCFullYear()}/${String(d.getUTCMonth()).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCHours()).padStart(2, "0")}h_ticks.bi5`, hourStart, "ticks", hourStart + HOUR < now - 15 * 60_000, hourStart + HOUR);
  }

  /** Awaits a set of file loads; a failed one leaves a gap and is counted, it does not fail the series. */
  private async collect(loads: Promise<Candle[] | null>[]): Promise<SeriesBuild> {
    const settled = await Promise.allSettled(loads);
    const candles: Candle[] = [];
    let missing = 0;
    for (const r of settled) {
      if (r.status === "rejected") missing++;
      else if (r.value) candles.push(...r.value);
    }
    return { candles, missing };
  }

  /**
   * Minute candles covering [from, now): completed days from minute files and, unless `today` is false,
   * today's completed hours from tick files. FX history for the dollar index skips today: it would cost
   * six tick files per hour and the live value covers the current day.
   */
  async minuteSeries(instrument: string, from: number, now: number, opts: { today?: boolean } = {}): Promise<SeriesBuild> {
    const todayStart = Math.floor(now / DAY) * DAY;
    const loads: Promise<Candle[] | null>[] = [];
    // Saturdays never trade (spot metals and FX close Friday 22:00 UTC): no request at all.
    for (let d = Math.floor(from / DAY) * DAY; d < todayStart; d += DAY) if (new Date(d).getUTCDay() !== 6) loads.push(this.dayMinuteFile(instrument, d, now));
    if (opts.today !== false) {
      const currentHour = Math.floor(now / HOUR) * HOUR;
      for (let h = todayStart; h < currentHour; h += HOUR) if (isSpotMarketOpen(h)) loads.push(this.hourTickFile(instrument, h, now));
    }
    const build = await this.collect(loads);
    build.candles.sort((a, b) => a.time - b.time);
    return build;
  }

  /** Hourly candles for the last `months` completed months (month files) plus the current month (minute data). */
  async hourlySeries(instrument: string, months: number, now: number, opts: { today?: boolean } = {}): Promise<SeriesBuild> {
    const d = new Date(now);
    const curYear = d.getUTCFullYear();
    const curMonth = d.getUTCMonth();
    const loads: Promise<Candle[] | null>[] = [];
    for (let k = months; k >= 1; k--) {
      const m = new Date(Date.UTC(curYear, curMonth - k, 1));
      loads.push(this.monthHourFile(instrument, m.getUTCFullYear(), m.getUTCMonth(), now));
    }
    const [completed, current] = await Promise.all([this.collect(loads), this.minuteSeries(instrument, Date.UTC(curYear, curMonth, 1), now, opts)]);
    return { candles: dedupe([...completed.candles, ...aggregate(current.candles, HOUR)]), missing: completed.missing + current.missing };
  }

  /** Daily candles for roughly the last `years` years (year files, then this year's months, then this month). */
  async dailySeries(instrument: string, years: number, now: number, opts: { today?: boolean } = {}): Promise<SeriesBuild> {
    const d = new Date(now);
    const curYear = d.getUTCFullYear();
    const yearLoads = Array.from({ length: years }, (_, i) => this.dayFile(instrument, curYear - years + i, now));
    const monthLoads = Array.from({ length: d.getUTCMonth() }, (_, m) => this.monthHourFile(instrument, curYear, m, now));
    const [yearly, monthly, current] = await Promise.all([this.collect(yearLoads), this.collect(monthLoads), this.minuteSeries(instrument, Date.UTC(curYear, d.getUTCMonth(), 1), now, opts)]);
    return { candles: dedupe([...yearly.candles, ...aggregate(monthly.candles, DAY), ...aggregate(current.candles, DAY)]), missing: yearly.missing + monthly.missing + current.missing };
  }

  /** Daily candles for the last `months` completed months plus the current month: no year files needed. */
  async recentDailySeries(instrument: string, months: number, now: number, opts: { today?: boolean } = {}): Promise<SeriesBuild> {
    const hourly = await this.hourlySeries(instrument, months, now, opts);
    return { candles: aggregate(hourly.candles, DAY), missing: hourly.missing };
  }
}

export function aggregate(candles: Candle[], bucketMs: number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of [...candles].sort((a, b) => a.time - b.time)) {
    const key = Math.floor(c.time / bucketMs) * bucketMs;
    if (!cur || cur.time !== key) {
      if (cur) out.push(cur);
      cur = { time: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function dedupe(candles: Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of candles.sort((a, b) => a.time - b.time)) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time);
}

export const dukascopy = new DukascopyClient();

/**
 * Dukascopy historical data feed (keyless, static files). Genuine bank price history for
 * spot gold (XAUUSD), the US Dollar Index (USDIDX) and FX majors.
 *
 * File layout (all times UTC, LZMA "alone" compressed, big-endian):
 *   {inst}/{year}/BID_candles_day_1.bi5                 daily candles for a completed year
 *   {inst}/{year}/{month0}/BID_candles_hour_1.bi5       hourly candles for a completed month
 *   {inst}/{year}/{month0}/{day}/BID_candles_min_1.bi5  minute candles for a completed day
 *   {inst}/{year}/{month0}/{day}/{HH}h_ticks.bi5        ticks for a completed hour
 * Candle record (24 B): time offset s, open, close, low, high (int32 × decimals), volume f32.
 * Tick record (20 B): time offset ms, ask, bid (int32 × decimals), askVol f32, bidVol f32.
 * Completed-period files are immutable and are cached on disk as decoded JSON.
 */
import fs from "node:fs/promises";
import path from "node:path";
import lzma from "lzma";
import type { Candle } from "@terminal/core";
import { config } from "../config";
import { logger } from "../lib/logger";
import { isSpotMarketOpen } from "./swissquote";

const log = logger("dukascopy");
const BASE = "https://datafeed.dukascopy.com/datafeed";
const UA = "CryptoGoldTerminal/0.2 (research; dukascopy historical feed)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
class TransientError extends Error {}
/** Price scaling per instrument (verified against the archive: EUR/USD 117455 → 1.17455, USD/JPY 156658 → 156.658, XAU/USD 3874585 → 3874.585). */
export const DECIMALS: Record<string, number> = { XAUUSD: 1000, XAGUSD: 1000, EURUSD: 100000, GBPUSD: 100000, USDCAD: 100000, USDSEK: 100000, USDCHF: 100000, USDJPY: 1000 };
const DAY = 86_400_000;
const HOUR = 3_600_000;

function lzmaDecompress(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    lzma.decompress(buf, (result: number[] | string, error?: Error) => {
      if (error) return reject(error);
      if (typeof result === "string") return resolve(Buffer.from(result, "binary"));
      resolve(Buffer.from(Uint8Array.from(result, (b) => b & 0xff)));
    });
  });
}

/** Fetch one archive file. The CDN answers bursts with 503, so transient failures are retried with backoff. */
async function fetchBi5(relPath: string): Promise<Buffer | null> {
  let delay = 1500;
  for (let attempt = 1; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    try {
      const res = await fetch(`${BASE}/${relPath}`, { headers: { "User-Agent": UA }, signal: ctrl.signal });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) throw new TransientError(`Dukascopy HTTP ${res.status} for ${relPath}`);
      if (!res.ok) throw new Error(`Dukascopy HTTP ${res.status} for ${relPath}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length < 20 ? null : buf;
    } catch (err) {
      const e = err as Error;
      const transient = e instanceof TransientError || e.name === "AbortError" || /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|terminated/i.test(e.message);
      if (!transient || attempt >= 4) throw e;
      await sleep(delay + Math.random() * 500);
      delay *= 2;
    } finally {
      clearTimeout(timer);
    }
  }
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

class DukascopyClient {
  private cacheDir = path.join(config.dataDir, "cache", "dukascopy");
  private inflight = new Map<string, Promise<Candle[] | null>>();
  private memo = new Map<string, { at: number; value: Candle[] | null }>();
  private active = 0;
  private queue: (() => void)[] = [];
  private readonly concurrency = 3; // the CDN starts returning 503 well before 6 parallel downloads

  private async limit<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  /** Load one archive file as candles; immutable (completed) periods are cached on disk forever. */
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
      const file = path.join(this.cacheDir, instrument, relPath.replace(/\//g, "_") + ".json");
      if (immutable) {
        try {
          const cached = JSON.parse(await fs.readFile(file, "utf8")) as { candles: Candle[] | null };
          this.memo.set(key, { at: Date.now(), value: cached.candles });
          return cached.candles;
        } catch {
          /* not cached */
        }
      }
      const value = await this.limit(async () => {
        const buf = await fetchBi5(`${instrument}/${relPath}`);
        if (!buf) return null;
        const raw = await lzmaDecompress(buf);
        const dec = DECIMALS[instrument] ?? 1000;
        return kind === "candles" ? decodeCandles(raw, baseTime, dec) : decodeTicksToMinutes(raw, baseTime, dec);
      });
      this.memo.set(key, { at: Date.now(), value });
      // Persist decoded immutable files; a 404 is persisted only once the period is comfortably in the past.
      if (immutable && (value !== null || periodEnd < Date.now() - 3 * DAY)) {
        try {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, JSON.stringify({ candles: value }));
        } catch (err) {
          log.warn(`cache write failed: ${(err as Error).message}`);
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

  /** Minute candles covering [from, now): completed days from minute files, today's completed hours from ticks. */
  async minuteSeries(instrument: string, from: number, now: number): Promise<Candle[]> {
    const todayStart = Math.floor(now / DAY) * DAY;
    const days: number[] = [];
    // Saturdays never trade (spot gold and FX close Friday 22:00 UTC) → no request at all.
    for (let d = Math.floor(from / DAY) * DAY; d < todayStart; d += DAY) if (new Date(d).getUTCDay() !== 6) days.push(d);
    const dayResults = await Promise.all(days.map((d) => this.dayMinuteFile(instrument, d, now).catch((err) => (log.warn(`minute file failed ${new Date(d).toISOString().slice(0, 10)}: ${(err as Error).message}`), null))));
    const out: Candle[] = [];
    for (const r of dayResults) if (r) out.push(...r);
    // Today: completed hours from tick files (and yesterday's missing day file via ticks if needed)
    const hours: number[] = [];
    const currentHour = Math.floor(now / HOUR) * HOUR;
    for (let h = todayStart; h < currentHour; h += HOUR) if (isSpotMarketOpen(h)) hours.push(h);
    const tickResults = await Promise.all(hours.map((h) => this.hourTickFile(instrument, h, now).catch(() => null)));
    for (const r of tickResults) if (r) out.push(...r);
    return out.sort((a, b) => a.time - b.time);
  }

  /** Hourly candles for the last `months` calendar months (completed months from month files, the rest from minute data). */
  async hourlySeries(instrument: string, months: number, now: number): Promise<Candle[]> {
    const d = new Date(now);
    const out: Candle[] = [];
    const curYear = d.getUTCFullYear();
    const curMonth = d.getUTCMonth();
    const monthStarts: [number, number][] = [];
    for (let k = months; k >= 1; k--) {
      const m = new Date(Date.UTC(curYear, curMonth - k, 1));
      monthStarts.push([m.getUTCFullYear(), m.getUTCMonth()]);
    }
    const files = await Promise.all(monthStarts.map(([y, m]) => this.monthHourFile(instrument, y, m, now).catch(() => null)));
    for (const f of files) if (f) out.push(...f);
    const monthStart = Date.UTC(curYear, curMonth, 1);
    const minutes = await this.minuteSeries(instrument, monthStart, now);
    out.push(...aggregate(minutes, HOUR));
    return dedupe(out);
  }

  /** Daily candles for roughly the last `years` years. */
  async dailySeries(instrument: string, years: number, now: number): Promise<Candle[]> {
    const d = new Date(now);
    const curYear = d.getUTCFullYear();
    const out: Candle[] = [];
    for (let y = curYear - years; y < curYear; y++) {
      const f = await this.dayFile(instrument, y, now).catch(() => null);
      if (f) out.push(...f);
    }
    // Current year: completed months from hour files, aggregated to days.
    const months: Candle[] = [];
    const files = await Promise.all(Array.from({ length: d.getUTCMonth() }, (_, m) => this.monthHourFile(instrument, curYear, m, now).catch(() => null)));
    for (const f of files) if (f) months.push(...f);
    out.push(...aggregate(months, DAY));
    const minutes = await this.minuteSeries(instrument, Date.UTC(curYear, d.getUTCMonth(), 1), now);
    out.push(...aggregate(minutes, DAY));
    return dedupe(out);
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

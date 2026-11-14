/**
 * Precious-metals & dollar-index data service.
 *  - Spot XAU/USD and spot XAG/USD: Dukascopy archive (history, bid side) + Swissquote live quotes
 *    sampled into minute candles for the current hour. Never a tokenised proxy, never a futures
 *    contract. Gold and silver go through exactly the same code path.
 *  - US Dollar Index: the ICE formula applied to the six constituent FX rates — history from the
 *    Dukascopy FX archive, live value from Swissquote. (Dukascopy's "USDIDX" instrument was probed
 *    and found to be a flat placeholder, so it is not used.)
 *  - Verification: Swissquote vs gold-api.com vs Dukascopy vs Twelve Data (if keyed), per metal.
 *  - Gold/silver ratio: the two spot quotes divided, with its one-year range from the daily closes.
 *  - First start: the archive is downloaded once in the background (see prewarm). No request waits for
 *    it: callers get WarmingError after a short wait and the UI retries.
 */
import fs from "node:fs";
import path from "node:path";
import type { AssetId, Candle, DataSource, Metal, MetalId, Quote, Timeframe } from "@terminal/core";
import { METALS, METAL_ASSETS, TIMEFRAME_MS, isMetalAsset } from "@terminal/core";
import { config } from "../config";
import { cache } from "../lib/cache";
import { logger } from "../lib/logger";
import { JsonStore } from "../lib/store";
import { UnavailableError, WarmSeries, isWarming, type Loaded } from "../lib/warming";
import { aggregate, dukascopy, type SeriesBuild } from "../providers/dukascopy";
import { dxyFromRates, getLiveDxyFromSwissquote, getMetalApiPrice, getSwissquoteQuote, isSpotMarketOpen, type SqQuote } from "../providers/swissquote";
import type { CandleProvider, CandleResult, QuoteProvider } from "../providers/types";
import { ProviderError } from "../providers/types";
import { getSyntheticDxy } from "../providers/macro";

const log = logger("metals");
const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface SeriesPoint {
  time: number;
  value: number;
}
export const DXY_PAIRS = ["EURUSD", "USDJPY", "GBPUSD", "USDCAD", "USDSEK", "USDCHF"] as const;

interface LiveStore {
  XAUUSD: Candle[];
  XAGUSD: Candle[];
  DXY: SeriesPoint[];
}

/** Samples live quotes so the current (unpublished) hour is never missing from the series. */
class LiveSampler {
  private store = new JsonStore<LiveStore>("live-candles", () => ({ XAUUSD: [], XAGUSD: [], DXY: [] }));
  private timer: NodeJS.Timeout | null = null;
  private mem: LiveStore | null = null;
  private lastSaved = 0;
  /** Which feeds failed at the last sample: a change is logged once, not on every sample. */
  private failedFeeds = "";
  /** The latest quote of each metal (null until the first sample has succeeded). */
  readonly last: Record<MetalId, SqQuote | null> = { XAUUSD: null, XAGUSD: null };
  readonly lastSampleAt: Record<MetalId, number> = { XAUUSD: 0, XAGUSD: 0 };
  lastDxy: { value: number; ts: number; components: Record<string, number> } | null = null;
  lastError: string | null = null;

  async init() {
    this.mem = await this.store.load();
    // A file written before silver was added has no XAGUSD list.
    for (const id of METAL_ASSETS) if (!Array.isArray(this.mem[id])) this.mem[id] = [];
    if (!Array.isArray(this.mem.DXY)) this.mem.DXY = [];
  }
  start() {
    void this.init().then(() => {
      void this.sample();
      this.timer = setInterval(() => void this.sample(), 15_000);
    });
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  /** Live-sampled minute candles of one metal (the last ten days at most). */
  candles(id: MetalId): Candle[] {
    return this.mem?.[id] ?? [];
  }
  dxyPoints(): SeriesPoint[] {
    return this.mem?.DXY ?? [];
  }
  private pushCandle(id: MetalId, price: number, ts: number) {
    if (!this.mem) return;
    const m = Math.floor(ts / 60_000) * 60_000;
    const arr = this.mem[id];
    const last = arr[arr.length - 1];
    if (last && last.time === m) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      last.volume += 1;
    } else if (!last || last.time < m) arr.push({ time: m, open: price, high: price, low: price, close: price, volume: 1 });
    const cutoff = Date.now() - 10 * DAY;
    while (arr.length && arr[0].time < cutoff) arr.shift();
  }
  private pushPoint(value: number, ts: number) {
    if (!this.mem) return;
    const arr = this.mem.DXY;
    const last = arr[arr.length - 1];
    if (!last || ts > last.time) arr.push({ time: ts, value });
    const cutoff = Date.now() - 10 * DAY;
    while (arr.length && arr[0].time < cutoff) arr.shift();
  }
  /** One round: both metals and the dollar index, each on its own so one failing feed does not stop the others. */
  async sample() {
    const now = Date.now();
    const [dxy, ...metals] = await Promise.allSettled([getLiveDxyFromSwissquote(), ...METAL_ASSETS.map((id) => getSwissquoteQuote(METALS[id].pair))]);
    const failed: string[] = [];
    let firstError: string | null = null;
    const fail = (feed: string, reason: unknown) => {
      failed.push(feed);
      firstError ??= reason instanceof Error ? reason.message : String(reason);
    };
    metals.forEach((r, i) => {
      const id = METAL_ASSETS[i];
      if (r.status === "rejected") return fail(METALS[id].pair, r.reason);
      const q = r.value as SqQuote;
      // The feed repeats the last quote while the market is closed; only fresh timestamps are recorded.
      if (this.last[id]?.ts !== q.ts) this.pushCandle(id, q.bid, q.ts);
      this.last[id] = q;
      this.lastSampleAt[id] = now;
    });
    if (dxy.status === "rejected") fail("dollar index", dxy.reason);
    else {
      const d = dxy.value as NonNullable<LiveSampler["lastDxy"]>;
      if (this.lastDxy?.ts !== d.ts) this.pushPoint(d.value, d.ts);
      this.lastDxy = d;
    }
    this.lastError = firstError;
    const failedFeeds = failed.join(", ");
    if (failedFeeds !== this.failedFeeds) {
      if (failedFeeds) log.warn(`live quotes unavailable for ${failedFeeds}: ${firstError} (retried every 15 s)`);
      else log.info("live quotes are back");
      this.failedFeeds = failedFeeds;
    }
    if (this.mem && now - this.lastSaved > 60_000) {
      this.lastSaved = now;
      await this.store.save(this.mem).catch((err: unknown) => log.warn(`could not save sampled quotes: ${(err as Error).message}`));
    }
  }
}

export const liveSampler = new LiveSampler();

/** Bucket archive candles and append live minute candles for buckets the archive does not cover yet. */
export function mergeLive(history: Candle[], live: Candle[], bucketMs: number, historyStepMs: number): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of aggregate(history, bucketMs)) m.set(c.time, c);
  const lastHist = history.length ? history[history.length - 1].time : 0;
  const cutoff = lastHist + historyStepMs; // first instant the archive has not published
  for (const c of aggregate(live.filter((c) => c.time >= cutoff), bucketMs)) {
    const existing = m.get(c.time);
    if (existing) m.set(c.time, { ...existing, high: Math.max(existing.high, c.high), low: Math.min(existing.low, c.low), close: c.close, volume: existing.volume + c.volume });
    else m.set(c.time, c);
  }
  return [...m.values()].sort((a, b) => a.time - b.time);
}

export function aggregateWeekly(daily: Candle[]): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of daily) {
    const dow = (new Date(c.time).getUTCDay() + 6) % 7; // Monday = 0
    const key = Math.floor(c.time / DAY) * DAY - dow * DAY;
    if (!cur || cur.time !== key) {
      if (cur) out.push(cur);
      cur = { ...c, time: key };
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

/** How long a request handler waits for archive data before answering "still downloading". */
export const REQUEST_WAIT_MS = 2500;
/** The dollar-index history is background work: requests give it only a moment (enough for a warm disk cache). */
const DXY_WAIT_MS = 800;
/**
 * On a machine with an empty cache, a gold or silver series that still has gaps (some files failed) is held back
 * this long while the missing files are retried. After that it is served flagged `incomplete`.
 */
const GAP_PATIENCE_MS = 4 * 60_000;
/** Months of FX history for the dollar index: enough for the 60-day statistics, with a margin. */
const DXY_MONTHS = 4;

const candleTtl = (timeframe: Timeframe) => (timeframe === "1d" || timeframe === "1w" ? 15 * 60_000 : timeframe === "4h" ? 5 * 60_000 : 60_000);

/**
 * Archive depth tiers. Requests are served from a few shared series (one per timeframe and depth)
 * instead of one cache entry per requested bar count.
 */
export function depthFor(timeframe: Timeframe, limit: number): number {
  const bucket = TIMEFRAME_MS[timeframe];
  if (timeframe === "1d" || timeframe === "1w") return 0; // always the full two years of daily bars
  if (timeframe === "1h" || timeframe === "4h") {
    const months = Math.ceil((limit * bucket) / (30 * DAY)) + 1;
    // Up to 8 months stays inside the month files the daily history needs anyway (no extra downloads).
    return months <= 2 ? 2 : months <= 5 ? 5 : months <= 8 ? 8 : 12;
  }
  const days = Math.max(3, Math.ceil((limit * bucket) / DAY) + 2);
  return days <= 5 ? 5 : days <= 12 ? 12 : 35; // calendar days
}

const metalSeries = new Map<string, WarmSeries<Candle[]>>();
const firstAttemptAt = new Map<string, number>();

/** When a first load with gaps may be served anyway: a few minutes after it was first tried. */
function gapDeadline(key: string): () => number {
  return () => (firstAttemptAt.get(key) ?? Date.now()) + GAP_PATIENCE_MS;
}

function requireMetal(assetId: AssetId): MetalId {
  if (!isMetalAsset(assetId)) throw new ProviderError("metal-spot", `${assetId} is not a spot metal`);
  return assetId;
}

/**
 * Guards against a wrong price scale in the archive decoding: the last archive close and the live
 * quote of the same instrument can never be several times apart. A series that fails this is not used.
 */
function assertMatchesLiveQuote(id: MetalId, candles: Candle[]): void {
  const live = liveSampler.last[id]?.mid;
  const last = candles.length ? candles[candles.length - 1].close : null;
  if (!live || !last) return;
  const ratio = last / live;
  if (ratio > 4 || ratio < 0.25) throw new Error(`${METALS[id].pair} archive history does not match the live quote (archive close ${last}, live ${live}); it is not used`);
}

function seriesFor(id: MetalId, timeframe: Timeframe, depth: number): WarmSeries<Candle[]> {
  const key = `${id}:${timeframe}:${depth}`;
  let series = metalSeries.get(key);
  if (!series) {
    series = new WarmSeries<Candle[]>(
      `Spot-${METALS[id].metal} price history`,
      async () => {
        const now = Date.now();
        if (!firstAttemptAt.has(key)) firstAttemptAt.set(key, now);
        const bucket = TIMEFRAME_MS[timeframe];
        let build: SeriesBuild;
        let step: number;
        if (timeframe === "1d" || timeframe === "1w") {
          build = await dukascopy.dailySeries(id, 2, now);
          step = DAY;
        } else if (timeframe === "1h" || timeframe === "4h") {
          build = await dukascopy.hourlySeries(id, depth, now);
          step = HOUR;
        } else {
          build = await dukascopy.minuteSeries(id, now - depth * DAY, now);
          step = 60_000;
        }
        assertMatchesLiveQuote(id, build.candles);
        // If the archive delivered nothing at all, a couple of live-sampled minutes are not a price history:
        // the series stays empty, which the provider reports as "no history available".
        const merged = build.candles.length ? mergeLive(build.candles, liveSampler.candles(id), bucket === 7 * DAY ? DAY : bucket, step) : [];
        const value = bucket === 7 * DAY ? aggregateWeekly(merged) : merged;
        // Gaps (failed files) or nothing at all: retried soon, and never presented as a whole series.
        const complete = build.missing === 0 && value.length > 0;
        return { value, ttlMs: complete ? candleTtl(timeframe) : 45_000, complete };
      },
      { partialAllowedAt: gapDeadline(key) },
    );
    metalSeries.set(key, series);
  }
  return series;
}

/**
 * What the archive has delivered of one metal so far: "none" when every series that was built came out
 * empty (the archive is not answering at all), "some" when at least one has data.
 */
function historyState(id: MetalId): "unknown" | "none" | "some" {
  let built = 0;
  let withData = 0;
  for (const [key, series] of metalSeries) {
    if (!key.startsWith(`${id}:`)) continue;
    const value = series.peek();
    if (value === undefined) continue;
    built++;
    if (value.length) withData++;
  }
  return built === 0 ? "unknown" : withData === 0 ? "none" : "some";
}

/** True when a series of this metal is being served with gaps (some archive files are still missing). */
function hasGaps(id: MetalId): boolean {
  if (historyState(id) === "none") return false; // nothing at all is its own state, reported as "unavailable"
  for (const [key, series] of metalSeries) if (key.startsWith(`${id}:`) && series.incomplete) return true;
  return false;
}

/** Metals whose history is out completely. The change is logged once each way, however many requests run into it. */
const historyOut = new Set<MetalId>();
function noteHistoryState(id: MetalId): void {
  const state = historyState(id);
  const { metal, title } = METALS[id];
  if (state === "none" && !historyOut.has(id)) {
    historyOut.add(id);
    log.warn(`spot ${metal} history is unavailable: the archive has delivered none of it. ${title} charts and analysis say so until it arrives (live prices are unaffected); the download is retried automatically`);
  } else if (state === "some" && historyOut.delete(id)) log.info(`spot ${metal} history is arriving: charts and analysis are available again`);
}

/**
 * Spot candles of one metal at a terminal timeframe: Dukascopy archive merged with live sampling.
 * A series that has never been loaded on this machine is awaited for at most `waitMs`, then the call
 * fails with WarmingError while the download continues. Pass Infinity to wait for the download.
 * `incomplete` is true when part of the history could not be downloaded yet.
 */
export async function getInstrumentSeries(id: MetalId, timeframe: Timeframe, limit: number, waitMs = REQUEST_WAIT_MS): Promise<{ candles: Candle[]; incomplete: boolean }> {
  const series = seriesFor(id, timeframe, depthFor(timeframe, limit));
  const candles = await series.get(waitMs);
  return { candles: candles.slice(-limit), incomplete: series.incomplete };
}

export async function getInstrumentCandles(id: MetalId, timeframe: Timeframe, limit: number, waitMs = REQUEST_WAIT_MS): Promise<Candle[]> {
  return (await getInstrumentSeries(id, timeframe, limit, waitMs)).candles;
}

const recentDaysSeries = new Map<MetalId, WarmSeries<Candle[]>>();

/** The last few UTC days of a metal from the smallest possible download: the latest minute files. */
function recentDays(id: MetalId): WarmSeries<Candle[]> {
  let series = recentDaysSeries.get(id);
  if (!series) {
    const key = `${id}:recent`;
    series = new WarmSeries<Candle[]>(
      `The previous spot-${METALS[id].metal} close`,
      async () => {
        const now = Date.now();
        if (!firstAttemptAt.has(key)) firstAttemptAt.set(key, now);
        // Three calendar days back is at most three files, one download round: enough for the previous close.
        const build = await dukascopy.minuteSeries(id, now - 3 * DAY, now);
        assertMatchesLiveQuote(id, build.candles);
        const days = aggregate(build.candles, DAY);
        const complete = build.missing === 0 && days.length > 0;
        return { value: days, ttlMs: complete ? 10 * 60_000 : 30_000, complete };
      },
      { partialAllowedAt: gapDeadline(key) },
    );
    recentDaysSeries.set(id, series);
  }
  return series;
}

/**
 * Recent daily candles for the quote (previous close, today's range). The quote must not depend on the
 * two-year daily history: on a new machine that takes minutes, these few files take seconds.
 */
async function recentDailyCandles(id: MetalId, waitMs: number): Promise<Candle[]> {
  return mergeLive(await recentDays(id).get(waitMs), liveSampler.candles(id), DAY, DAY);
}

function spotSource(label: string, asOf: number, quality: DataSource["quality"], note: string, url?: string): DataSource {
  return { provider: "dukascopy+swissquote", label, fetchedAt: Date.now(), asOf, quality, proxy: false, note, url };
}

/** What a spot metal is NOT, said next to every series: the usual stand-ins are different instruments. */
const NOT_A_STAND_IN: Record<Metal, string> = { gold: "not PAXG, not COMEX futures", silver: "not a silver token or ETF, not COMEX futures" };

/** Keyless spot provider for both metals: archive history plus live sampling, and the live quote. */
export class MetalSpotProvider implements CandleProvider, QuoteProvider {
  readonly id = "metal-spot";
  supports(assetId: AssetId): boolean {
    return isMetalAsset(assetId);
  }
  async getCandles(assetId: AssetId, timeframe: Timeframe, limit: number, waitMs = REQUEST_WAIT_MS): Promise<CandleResult> {
    const id = requireMetal(assetId);
    const { metal, pair } = METALS[id];
    const { candles, incomplete } = await getInstrumentSeries(id, timeframe, limit, waitMs);
    noteHistoryState(id);
    // Nothing to show is said as such. It is never filled with demo candles: a synthetic chart next to the
    // real live price would mislead, however it is labelled.
    if (!candles.length) throw new UnavailableError(`Spot ${metal} price history could not be downloaded yet: the archive is not answering. It is retried automatically, and nothing is shown in its place.`);
    const last = candles[candles.length - 1];
    const now = Date.now();
    const open = isSpotMarketOpen(now);
    const expectedGap = Math.max(TIMEFRAME_MS[timeframe], 2 * HOUR);
    const quality: DataSource["quality"] = !open ? "closed" : now - last.time <= expectedGap + 30 * 60_000 ? "live" : "stale";
    const source = spotSource(
      `Spot ${pair} — Dukascopy bid candles + Swissquote live sampling`,
      last.time,
      quality,
      `Genuine OTC spot ${metal} (${NOT_A_STAND_IN[metal]}). History from the Dukascopy archive (bid side, UTC-aligned bars); the current hour is sampled from Swissquote's public quote feed. ${open ? "Market open." : "Spot market closed (trades Sun ~22:00 to Fri ~22:00 UTC); weekend gaps are real."}${incomplete ? " Part of this history could not be downloaded yet (the archive is refusing some files), so the series has gaps; it is completed automatically." : ""}`,
      "https://www.dukascopy.com/swiss/english/marketwatch/historical/",
    );
    return { candles, source: incomplete ? { ...source, incomplete: true } : source };
  }
  async getQuote(assetId: AssetId): Promise<Quote> {
    const id = requireMetal(assetId);
    const { metal, pair } = METALS[id];
    const q = liveSampler.last[id] ?? (await getSwissquoteQuote(pair));
    const now = Date.now();
    const age = now - q.ts;
    const open = isSpotMarketOpen(now);
    const quality: DataSource["quality"] = !open ? "closed" : age < 2 * 60_000 ? "live" : age < 20 * 60_000 ? "delayed" : "stale";
    // For the first seconds on a machine that has never downloaded this metal's data this throws WarmingError:
    // a price shown without its previous close would carry a made-up "0.00 %" change.
    const daily = await recentDailyCandles(id, REQUEST_WAIT_MS).catch((err: unknown) => {
      if (isWarming(err)) throw err;
      return [] as Candle[];
    });
    const today = daily.length && daily[daily.length - 1].time >= Math.floor(now / DAY) * DAY - (open ? 0 : 3 * DAY) ? daily[daily.length - 1] : null;
    // Without a previous close there is no change to report: it is left out, never shown as 0.00 %.
    const prevClose = daily.length >= 2 ? daily[daily.length - 2].close : null;
    const changeBasis = prevClose !== null ? "Change is versus the previous UTC daily close from the Dukascopy archive." : "The previous close is unavailable (the archive is not answering), so no change is shown.";
    return {
      assetId,
      price: q.mid,
      change24h: prevClose !== null ? q.mid - prevClose : null,
      changePct24h: prevClose ? ((q.mid - prevClose) / prevClose) * 100 : null,
      // (Without archive data the "day" would be a few sampled quotes: no range is reported either.)
      high24h: today && prevClose !== null ? Math.max(today.high, q.mid) : undefined,
      low24h: today && prevClose !== null ? Math.min(today.low, q.mid) : undefined,
      source: {
        provider: "swissquote",
        label: `Spot ${pair} — Swissquote public BBO (prime), mid of bid/ask`,
        fetchedAt: now,
        asOf: q.ts,
        quality,
        proxy: false,
        note: `${open ? "Spot market open." : `Spot ${metal} market closed (trades Sun ~22:00 to Fri ~22:00 UTC); showing the last quote.`} Bid ${q.bid} / ask ${q.ask} (spread ${q.spread.toFixed(3)}). ${changeBasis}`,
        url: `https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${pair}`,
      },
    };
  }
}

/**
 * DXY history from the six constituent archives (bar closes, intersected on timestamp). Only completed
 * days are used: today's value comes from the live quotes, which saves six archive files per hour.
 */
async function loadDxyHistory(step: "1h" | "1d"): Promise<Loaded<SeriesPoint[]>> {
  const now = Date.now();
  const builds = await Promise.all(DXY_PAIRS.map((pair) => (step === "1d" ? dukascopy.recentDailySeries(pair, DXY_MONTHS, now, { today: false }) : dukascopy.hourlySeries(pair, 1, now, { today: false }))));
  const missing = builds.reduce((n, b) => n + b.missing, 0);
  let points: SeriesPoint[] = [];
  if (!builds.some((b) => b.candles.length === 0)) {
    const maps = builds.map((b) => new Map(b.candles.map((c) => [c.time, c.close] as const)));
    const times = [...maps[0].keys()].filter((t) => maps.every((m) => m.has(t))).sort((a, b) => a - b);
    points = times.map((t) => ({ time: t, value: dxyFromRates({ EURUSD: maps[0].get(t)!, USDJPY: maps[1].get(t)!, GBPUSD: maps[2].get(t)!, USDCAD: maps[3].get(t)!, USDSEK: maps[4].get(t)!, USDCHF: maps[5].get(t)! }) }));
  }
  const complete = missing === 0 && points.length > 0;
  return { value: points, ttlMs: complete ? 30 * 60_000 : 60_000, complete };
}

/**
 * The close-based dollar-index history is a precision upgrade, not a requirement: until every file of
 * all six pairs is there, callers fall back to the ECB reference-rate series. A first value with gaps is
 * therefore never published (a gap in one pair would shift the whole index).
 */
const dxySeries: Record<"1h" | "1d", WarmSeries<SeriesPoint[]>> = {
  "1h": new WarmSeries("US Dollar Index history", () => loadDxyHistory("1h"), { partialAllowedAt: () => Infinity, rebuildMs: 20_000 }),
  "1d": new WarmSeries("US Dollar Index history", () => loadDxyHistory("1d"), { partialAllowedAt: () => Infinity, rebuildMs: 20_000 }),
};

/** Like the metal series: waits at most `waitMs` on a cold cache, then fails with WarmingError. */
export function dxyHistory(step: "1h" | "1d", waitMs = DXY_WAIT_MS): Promise<SeriesPoint[]> {
  return dxySeries[step].get(waitMs);
}

// ---------------------------------------------------------------------------------------------------
// First-start warm-up
// ---------------------------------------------------------------------------------------------------

export interface WarmupStep {
  id: string;
  metal: Metal;
  label: string;
  state: "pending" | "running" | "done" | "failed";
  ms: number | null;
  error?: string;
}

const warmup = {
  firstRun: false,
  /** Metals whose history had never been downloaded on this machine when the server started. */
  firstTime: [] as Metal[],
  startedAt: 0,
  finishedAt: 0,
  steps: [] as WarmupStep[],
  dollarIndex: "pending" as "pending" | "downloading" | "ready",
};

/** True when this machine has no downloaded history of this metal yet (a fresh clone, a wiped data folder, or a metal added by an update). */
function archiveCacheIsEmpty(id: MetalId): boolean {
  try {
    return fs.readdirSync(path.join(config.dataDir, "cache", "dukascopy", id)).length < 5;
  } catch {
    return true;
  }
}

/**
 * Progress of the background downloads, for the first-start notice in the UI. `warming` covers the gold
 * and silver history only: the dollar-index history keeps downloading afterwards without holding anything up.
 */
export function getWarmupStatus() {
  return {
    warming: warmup.startedAt > 0 && warmup.finishedAt === 0,
    /** Nothing at all had been downloaded before this start. */
    firstRun: warmup.firstRun,
    firstTime: [...warmup.firstTime],
    startedAt: warmup.startedAt || null,
    finishedAt: warmup.finishedAt || null,
    steps: warmup.steps.map((s) => ({ ...s })),
    /** Some history of this metal is being served with gaps because the archive kept refusing files. */
    goldGaps: hasGaps("XAUUSD"),
    silverGaps: hasGaps("XAGUSD"),
    /** Metals of which the archive has delivered nothing at all after the patience window: their charts and analysis report it. */
    unavailable: METAL_ASSETS.filter((id) => historyState(id) === "none").map((id) => METALS[id].metal),
    dollarIndex: warmup.dollarIndex,
    archive: dukascopy.progress(),
  };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
const listOf = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * What the pages of one metal need, most visible first: the quote, intraday charts, hourly charts, daily
 * history. Each part resolves with the series it loaded (empty ones when the archive delivered nothing).
 */
const WARMUP_PARTS: { part: string; label: (metal: Metal) => string; run: (id: MetalId) => Promise<Candle[][]> }[] = [
  { part: "quote", label: (m) => `${m} price`, run: async (id) => [await recentDays(id).get(Infinity)] },
  { part: "intraday", label: (m) => `${m} 5m and 15m charts`, run: (id) => Promise.all([getInstrumentCandles(id, "15m", 500, Infinity), getInstrumentCandles(id, "5m", 500, Infinity)]) },
  { part: "hourly", label: (m) => `${m} 1h chart`, run: async (id) => [await getInstrumentCandles(id, "1h", 600, Infinity)] },
  { part: "daily", label: (m) => `${m} daily and weekly history`, run: (id) => Promise.all([getInstrumentCandles(id, "1d", 500, Infinity), getInstrumentCandles(id, "1w", 300, Infinity)]) },
  { part: "hourly-deep", label: (m) => `${m} 4h chart and deep hourly history`, run: (id) => Promise.all([getInstrumentCandles(id, "4h", 600, Infinity), getInstrumentCandles(id, "1h", 1000, Infinity), getInstrumentCandles(id, "4h", 1000, Infinity)]) },
];

/**
 * Loads everything the gold and silver pages need in the background. Request handlers never wait for
 * this. The close-based dollar-index history follows afterwards at a gentle pace and is not part of
 * "warming".
 */
export async function prewarm(): Promise<void> {
  const t0 = Date.now();
  // Listed in the order the downloader delivers them: each part for gold, then the same part for silver.
  const plan = WARMUP_PARTS.flatMap(({ part, label, run }) => METAL_ASSETS.map((id) => ({ id: `${METALS[id].metal}-${part}`, metalId: id, metal: METALS[id].metal, label: label(METALS[id].metal), run: () => run(id) })));
  warmup.firstTime = METAL_ASSETS.filter(archiveCacheIsEmpty).map((id) => METALS[id].metal);
  warmup.firstRun = warmup.firstTime.length === METAL_ASSETS.length;
  warmup.startedAt = t0;
  warmup.finishedAt = 0;
  warmup.dollarIndex = "pending";
  warmup.steps = plan.map(({ id, metal, label }) => ({ id, metal, label, state: "pending", ms: null }));
  if (warmup.firstRun) log.info("first start on this machine: downloading spot gold and silver history in the background (cached afterwards)");
  else if (warmup.firstTime.length) log.info(`downloading spot ${listOf(warmup.firstTime)} history for the first time on this machine, in the background (cached afterwards)`);
  // Every series starts now, so all their files are queued together and the downloader can order them
  // (gold before silver, newest first). The steps below only report them in the order a user notices them.
  const running = plan.map(({ run }) => run().then((loaded) => ({ empty: loaded.every((series) => series.length === 0), failure: null }), (err: unknown) => ({ empty: true, failure: err instanceof Error ? err : new Error(String(err)) })));
  for (let i = 0; i < plan.length; i++) {
    const step = warmup.steps[i];
    step.state = "running";
    const { empty, failure } = await running[i];
    step.ms = Date.now() - t0;
    if (failure) {
      step.state = "failed";
      step.error = failure.message;
      log.warn(`prewarm ${step.label} failed: ${failure.message}`);
    } else {
      step.state = "done";
      // A part that came out empty is not announced line by line: the summary below says it once.
      if (empty) log.debug(`prewarm ${step.label} not available yet (${seconds(step.ms)})`);
      else log.info(`prewarm ${step.label} ${hasGaps(plan[i].metalId) ? "loaded with gaps" : "ready"} (${seconds(step.ms)})`);
    }
  }
  warmup.finishedAt = Date.now();
  const gappy = METAL_ASSETS.filter(hasGaps).map((id) => METALS[id].metal);
  const none = METAL_ASSETS.filter((id) => historyState(id) === "none").map((id) => METALS[id].metal);
  for (const id of METAL_ASSETS) noteHistoryState(id);
  if (none.length) log.info(`the first download round is over without any ${listOf(none)} history: the archive is not answering, it is retried in the background (${seconds(warmup.finishedAt - t0)})`);
  if (none.length < METAL_ASSETS.length) log.info(`${listOf(METAL_ASSETS.map((id) => METALS[id].metal).filter((m) => !none.includes(m)))} history ${gappy.length ? `loaded with gaps in ${listOf(gappy)}: the archive is refusing some files, they are retried in the background` : "ready"} (${seconds(warmup.finishedAt - t0)})`);

  warmup.dollarIndex = "downloading";
  const t1 = Date.now();
  await Promise.all([dxyHistory("1h", Infinity), dxyHistory("1d", Infinity)]).then(
    () => {
      warmup.dollarIndex = "ready";
      log.info(`dollar-index history ready (${seconds(Date.now() - t1)})`);
    },
    (err: unknown) => log.warn(`dollar-index history failed: ${(err as Error).message}`),
  );
}

export interface DxyData {
  value: number;
  ts: number;
  quality: DataSource["quality"];
  source: DataSource;
  components: Record<string, number> | null;
  history1d: SeriesPoint[];
  history1h: SeriesPoint[];
  archiveLastClose: SeriesPoint | null;
  computedVsArchivePct: number | null;
  /** True while the close-based history is still being downloaded (only the live value is available). */
  historyWarming: boolean;
}

export async function getDxy(waitMs = DXY_WAIT_MS): Promise<DxyData> {
  const now = Date.now();
  let historyWarming = false;
  const soft = (step: "1h" | "1d") =>
    dxyHistory(step, waitMs).catch((err: unknown) => {
      if (isWarming(err)) historyWarming = true;
      else log.warn(`DXY ${step} history unavailable: ${(err as Error).message}`);
      return [] as SeriesPoint[];
    });
  const [d1, h1] = await Promise.all([soft("1d"), soft("1h")]);
  const live = liveSampler.lastDxy ?? (await getLiveDxyFromSwissquote().catch(() => null));
  const archiveLast = h1.length ? h1[h1.length - 1] : d1.length ? d1[d1.length - 1] : null;
  // Append live hourly closes for hours the archive does not cover (it stops at the last completed day).
  const hourly = new Map<number, number>();
  for (const p of liveSampler.dxyPoints()) if (!archiveLast || p.time >= archiveLast.time + HOUR) hourly.set(Math.floor(p.time / HOUR) * HOUR, p.value);
  const history1h = [...h1, ...[...hourly.entries()].map(([time, value]) => ({ time, value }))].sort((a, b) => a.time - b.time);
  const open = isSpotMarketOpen(now);
  const value = live?.value ?? archiveLast?.value ?? NaN;
  const ts = live?.ts ?? archiveLast?.time ?? now;
  const quality: DataSource["quality"] = !Number.isFinite(value) ? "unavailable" : !open ? "closed" : now - ts < 2 * 60_000 ? "live" : "delayed";
  return {
    value,
    ts,
    quality,
    components: live?.components ?? null,
    history1d: d1,
    history1h,
    archiveLastClose: archiveLast,
    computedVsArchivePct: live && archiveLast ? ((live.value - archiveLast.value) / archiveLast.value) * 100 : null,
    historyWarming,
    source: {
      provider: "dukascopy+swissquote",
      label: "US Dollar Index — ICE formula on live Swissquote FX (now) and the Dukascopy FX archive (history)",
      fetchedAt: now,
      asOf: ts,
      quality,
      proxy: false,
      note: `DXY = 50.14348112 × EURUSD^-0.576 × USDJPY^0.136 × GBPUSD^-0.119 × USDCAD^0.091 × USDSEK^0.042 × USDCHF^0.036, computed from bank quotes of the six constituents. It is the index definition itself, not the licensed ICE Data Services print, so it can differ from the ICE value by a few hundredths. ${open ? "FX market open." : "FX market closed; showing the last quotes."}${historyWarming ? " The close-based history is still being downloaded in the background; only the live value is available yet." : ""}`,
      url: "https://www.theice.com/products/194/US-Dollar-Index-Futures",
    },
  };
}

/** How far the spot sources of a metal may be apart and still count as agreeing (the archive row is an hourly close, up to an hour or two old; silver moves about twice as much as gold in that time). */
const SPOT_TOLERANCE_PCT: Record<Metal, number> = { gold: 0.5, silver: 1.0 };

export interface MetalVerification {
  metal: Metal;
  checkedAt: number;
  marketOpen: boolean;
  /** True while the archive is still being downloaded for the first time: its rows are missing, not wrong. */
  warming: boolean;
  spot: {
    swissquote: { price: number; ts: number } | null;
    goldApi: { price: number; ts: number } | null;
    dukascopyLastClose: { price: number; ts: number } | null;
    twelveData: { price: number; ts: number } | null;
    maxDeviationPct: number | null;
    /** Sources further apart than this are reported as divergent. */
    tolerancePct: number;
    status: "verified" | "divergent" | "insufficient";
  };
  dxy: {
    live: { value: number; ts: number } | null;
    archiveLastClose: { value: number; ts: number } | null;
    syntheticEcb: { value: number; date: string } | null;
    maxDeviationPct: number | null;
    status: "verified" | "divergent" | "insufficient";
  };
  notes: string[];
}
export type GoldVerification = MetalVerification;

const archiveHourlySeries = new Map<MetalId, WarmSeries<Candle[]>>();

/** Archive-only hourly bars for the verification row: never mixed with the live sampler. */
function archiveHourly(id: MetalId): WarmSeries<Candle[]> {
  let series = archiveHourlySeries.get(id);
  if (!series) {
    series = new WarmSeries<Candle[]>(`The spot-${METALS[id].metal} archive`, async () => {
      const build = await dukascopy.hourlySeries(id, 1, Date.now());
      const hours = build.candles.filter((c) => c.volume > 0);
      return { value: hours, ttlMs: hours.length && build.missing === 0 ? 60_000 : 30_000 };
    });
    archiveHourlySeries.set(id, series);
  }
  return series;
}

/** Cross-checks the spot price of one metal across independent sources, and the dollar index against its archive. */
export async function getMetalVerification(id: MetalId): Promise<MetalVerification> {
  const { metal, code, pair } = METALS[id];
  const cacheKey = `${metal}:verification`;
  const cached = cache.get<MetalVerification>(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const now = Date.now();
  const open = isSpotMarketOpen(now);
  const notes: string[] = [];
  let warming = false;
  const sampled = liveSampler.last[id];
  const [sq, ga, h1, dxy, synth, td] = await Promise.allSettled([
    sampled ? Promise.resolve(sampled) : getSwissquoteQuote(pair),
    getMetalApiPrice(code as "XAU" | "XAG"),
    archiveHourly(id).get(REQUEST_WAIT_MS),
    getDxy(),
    getSyntheticDxy(10),
    config.hasTwelveData ? import("../providers/twelvedata").then((m) => new m.TwelveDataMetalProvider().getQuote(id)) : Promise.resolve(null),
  ]);
  const v = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
  if (h1.status === "rejected" && isWarming(h1.reason)) warming = true;
  const sqq = v(sq);
  const gaq = v(ga);
  const hh = v(h1) ?? [];
  const dd = v(dxy);
  const ss = v(synth);
  const tdq = v(td);
  const lastHour = hh.length ? hh[hh.length - 1] : null;
  const spotPoints: number[] = [];
  if (sqq) spotPoints.push(sqq.mid);
  if (gaq) spotPoints.push(gaq.price);
  if (lastHour) spotPoints.push(lastHour.close);
  if (tdq) spotPoints.push(tdq.price);
  const dev = (pts: number[]) => (pts.length >= 2 ? ((Math.max(...pts) - Math.min(...pts)) / (pts.reduce((a, b) => a + b, 0) / pts.length)) * 100 : null);
  const spotDev = dev(spotPoints);
  const tolerancePct = SPOT_TOLERANCE_PCT[metal];
  const spotStatus = spotDev === null ? "insufficient" : spotDev <= tolerancePct ? "verified" : "divergent";
  if (warming) notes.push("The Dukascopy archive is still being downloaded for the first time on this machine, so its row is missing for now.");
  if (dd?.historyWarming) notes.push("The close-based dollar-index history is still being downloaded in the background; the live value is unaffected.");
  if (!open) notes.push("Spot market is closed; sources show their last quotes, which can differ slightly depending on each feed's closing time.");
  if (spotStatus === "divergent") notes.push(`Spot sources differ by ${spotDev?.toFixed(2)}% — treat the price with caution until they converge.`);
  if (spotStatus === "insufficient") notes.push("Fewer than two independent spot sources responded; the price could not be cross-checked.");
  const dxyPts: number[] = [];
  if (dd?.components) dxyPts.push(dd.value);
  if (dd?.archiveLastClose) dxyPts.push(dd.archiveLastClose.value);
  const dxyDev = dev(dxyPts);
  const dxyStatus = dxyDev === null ? "insufficient" : dxyDev <= 0.3 ? "verified" : "divergent";
  if (ss) notes.push(`ECB-fixing synthetic DXY (${ss.latest.toFixed(2)} on ${ss.points[ss.points.length - 1]?.date}) is a daily reference only and is not used for the live value.`);
  if (!v(sq)) notes.push("Swissquote quote unavailable.");
  if (!gaq) notes.push("gold-api.com unavailable.");
  const pending = warming || !!dd?.historyWarming;
  const result: MetalVerification = {
    metal,
    checkedAt: now,
    marketOpen: open,
    warming: pending,
    spot: {
      swissquote: sqq ? { price: sqq.mid, ts: sqq.ts } : null,
      goldApi: gaq,
      dukascopyLastClose: lastHour ? { price: lastHour.close, ts: lastHour.time + HOUR } : null,
      twelveData: tdq ? { price: tdq.price, ts: tdq.source.asOf } : null,
      maxDeviationPct: spotDev,
      tolerancePct,
      status: spotStatus,
    },
    dxy: {
      live: dd?.components ? { value: dd.value, ts: dd.ts } : null,
      archiveLastClose: dd?.archiveLastClose ? { value: dd.archiveLastClose.value, ts: dd.archiveLastClose.time } : null,
      syntheticEcb: ss ? { value: ss.latest, date: ss.points[ss.points.length - 1]?.date ?? "" } : null,
      maxDeviationPct: dxyDev,
      status: dxyStatus,
    },
    notes,
  };
  // While something is still downloading the result is refreshed quickly instead of being kept for a minute.
  cache.set(cacheKey, result, pending ? 10_000 : 60_000);
  return result;
}

export interface GoldSilverRatio {
  /** Ounces of silver that one ounce of gold buys right now (spot XAU/USD ÷ spot XAG/USD); null if a quote is missing. */
  value: number | null;
  ts: number | null;
  gold: number | null;
  silver: number | null;
  /** Where the ratio sits in its own last year of daily closes; null until both daily histories are loaded. */
  year: { high: number; low: number; percentile: number; change20dPct: number | null; days: number } | null;
  source: DataSource;
}

/**
 * The gold/silver ratio from the two spot quotes. Never waits for a download: the one-year range is
 * simply left out while either daily history is still loading or has gaps.
 */
export async function getGoldSilverRatio(): Promise<GoldSilverRatio> {
  const now = Date.now();
  const quote = (id: MetalId) => (liveSampler.last[id] ? Promise.resolve(liveSampler.last[id] as SqQuote) : getSwissquoteQuote(METALS[id].pair));
  const daily = (id: MetalId) => getInstrumentSeries(id, "1d", 400, 0);
  const [g, sv, gd, sd] = await Promise.allSettled([quote("XAUUSD"), quote("XAGUSD"), daily("XAUUSD"), daily("XAGUSD")]);
  const gold = g.status === "fulfilled" ? g.value : null;
  const silver = sv.status === "fulfilled" ? sv.value : null;
  const value = gold && silver && silver.mid > 0 ? gold.mid / silver.mid : null;
  let year: GoldSilverRatio["year"] = null;
  if (gd.status === "fulfilled" && sd.status === "fulfilled" && !gd.value.incomplete && !sd.value.incomplete) {
    const silverClose = new Map(sd.value.candles.map((c) => [c.time, c.close] as const));
    const series = gd.value.candles.filter((c) => (silverClose.get(c.time) ?? 0) > 0).map((c) => c.close / (silverClose.get(c.time) as number)).slice(-252);
    const current = value ?? series[series.length - 1];
    if (series.length >= 60 && current) {
      const past = series.length > 20 ? series[series.length - 21] : null;
      year = { high: Math.max(...series), low: Math.min(...series), percentile: series.filter((x) => x <= current).length / series.length, change20dPct: past ? ((current - past) / past) * 100 : null, days: series.length };
    }
  }
  const open = isSpotMarketOpen(now);
  const ts = gold && silver ? Math.min(gold.ts, silver.ts) : null;
  const quality: DataSource["quality"] = value === null ? "unavailable" : !open ? "closed" : now - (ts as number) < 2 * 60_000 ? "live" : "delayed";
  return {
    value,
    ts,
    gold: gold?.mid ?? null,
    silver: silver?.mid ?? null,
    year,
    source: {
      provider: "swissquote",
      label: "Gold/silver ratio — spot XAU/USD ÷ spot XAG/USD (Swissquote mids)",
      fetchedAt: now,
      asOf: ts ?? now,
      quality,
      proxy: false,
      note: `How many ounces of silver one ounce of gold buys, computed from the two live spot quotes.${year ? ` The one-year range uses ${year.days} daily closes of both metals from the Dukascopy archive.` : " The one-year range appears once both daily histories are loaded."} A descriptive measure, not a signal.`,
    },
  };
}

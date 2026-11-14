/**
 * Gold & dollar-index data service.
 *  - Spot XAU/USD: Dukascopy archive (history, bid side) + Swissquote live quotes sampled into
 *    minute candles for the current hour. Never a tokenised proxy, never a futures contract.
 *  - US Dollar Index: the ICE formula applied to the six constituent FX rates — history from the
 *    Dukascopy FX archive, live value from Swissquote. (Dukascopy's "USDIDX" instrument was probed
 *    and found to be a flat placeholder, so it is not used.)
 *  - Verification: Swissquote vs gold-api.com vs Dukascopy vs Twelve Data (if keyed).
 *  - First start: the archive is downloaded once in the background (see prewarm). No request waits for
 *    it: callers get WarmingError after a short wait and the UI retries.
 */
import fs from "node:fs";
import path from "node:path";
import type { AssetId, Candle, DataSource, Quote, Timeframe } from "@terminal/core";
import { TIMEFRAME_MS } from "@terminal/core";
import { config } from "../config";
import { cache } from "../lib/cache";
import { logger } from "../lib/logger";
import { JsonStore } from "../lib/store";
import { WarmSeries, isWarming, type Loaded } from "../lib/warming";
import { aggregate, dukascopy } from "../providers/dukascopy";
import { dxyFromRates, getGoldApiPrice, getLiveDxyFromSwissquote, getSwissquoteQuote, isSpotMarketOpen, type SqQuote } from "../providers/swissquote";
import type { CandleProvider, CandleResult, QuoteProvider } from "../providers/types";
import { getSyntheticDxy } from "../providers/macro";

const log = logger("gold");
const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface SeriesPoint {
  time: number;
  value: number;
}
export const DXY_PAIRS = ["EURUSD", "USDJPY", "GBPUSD", "USDCAD", "USDSEK", "USDCHF"] as const;

interface LiveStore {
  XAUUSD: Candle[];
  DXY: SeriesPoint[];
}

/** Samples live quotes so the current (unpublished) hour is never missing from the series. */
class LiveSampler {
  private store = new JsonStore<LiveStore>("live-candles", () => ({ XAUUSD: [], DXY: [] }));
  private timer: NodeJS.Timeout | null = null;
  private mem: LiveStore | null = null;
  private lastSaved = 0;
  lastXau: SqQuote | null = null;
  lastDxy: { value: number; ts: number; components: Record<string, number> } | null = null;
  lastError: string | null = null;
  lastSampleAt = 0;

  async init() {
    this.mem = await this.store.load();
    if (!Array.isArray(this.mem.XAUUSD)) this.mem.XAUUSD = [];
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
  xauCandles(): Candle[] {
    return this.mem?.XAUUSD ?? [];
  }
  dxyPoints(): SeriesPoint[] {
    return this.mem?.DXY ?? [];
  }
  private pushCandle(price: number, ts: number) {
    if (!this.mem) return;
    const m = Math.floor(ts / 60_000) * 60_000;
    const arr = this.mem.XAUUSD;
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
  async sample() {
    const now = Date.now();
    try {
      const xau = await getSwissquoteQuote("XAU/USD");
      // The feed repeats the last quote while the market is closed; only fresh timestamps are recorded.
      if (!this.lastXau || xau.ts !== this.lastXau.ts) this.pushCandle(xau.bid, xau.ts);
      this.lastXau = xau;
      const dxy = await getLiveDxyFromSwissquote();
      if (!this.lastDxy || dxy.ts !== this.lastDxy.ts) this.pushPoint(dxy.value, dxy.ts);
      this.lastDxy = dxy;
      this.lastError = null;
      this.lastSampleAt = now;
      if (this.mem && now - this.lastSaved > 60_000) {
        this.lastSaved = now;
        await this.store.save(this.mem);
      }
    } catch (err) {
      this.lastError = (err as Error).message;
      log.warn(`sampler: ${this.lastError}`);
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

const xauSeries = new Map<string, WarmSeries<Candle[]>>();

function xauSeriesFor(timeframe: Timeframe, depth: number): WarmSeries<Candle[]> {
  const key = `${timeframe}:${depth}`;
  let series = xauSeries.get(key);
  if (!series) {
    series = new WarmSeries<Candle[]>("Spot-gold price history", async () => {
      const now = Date.now();
      const missesBefore = dukascopy.stats.misses;
      const bucket = TIMEFRAME_MS[timeframe];
      let history: Candle[];
      let step: number;
      if (timeframe === "1d" || timeframe === "1w") {
        history = await dukascopy.dailySeries("XAUUSD", 2, now);
        step = DAY;
      } else if (timeframe === "1h" || timeframe === "4h") {
        history = await dukascopy.hourlySeries("XAUUSD", depth, now);
        step = HOUR;
      } else {
        history = await dukascopy.minuteSeries("XAUUSD", now - depth * DAY, now);
        step = 60_000;
      }
      const merged = mergeLive(history, liveSampler.xauCandles(), bucket === 7 * DAY ? DAY : bucket, step);
      const value = bucket === 7 * DAY ? aggregateWeekly(merged) : merged;
      // An empty or partly failed download is retried soon instead of being served for the full TTL.
      const complete = value.length > 0 && dukascopy.stats.misses === missesBefore;
      return { value, ttlMs: complete ? candleTtl(timeframe) : 45_000 };
    });
    xauSeries.set(key, series);
  }
  return series;
}

/**
 * Spot XAU/USD candles at a terminal timeframe: Dukascopy archive merged with live sampling.
 * A series that has never been loaded on this machine is awaited for at most `waitMs`, then the call
 * fails with WarmingError while the download continues. Pass Infinity to wait for the download.
 */
export async function getInstrumentCandles(_instrument: "XAUUSD", timeframe: Timeframe, limit: number, waitMs = REQUEST_WAIT_MS): Promise<Candle[]> {
  const candles = await xauSeriesFor(timeframe, depthFor(timeframe, limit)).get(waitMs);
  return candles.slice(-limit);
}

/** The last few UTC days of spot gold from the smallest possible download: the latest minute files. */
const recentDays = new WarmSeries<Candle[]>("The previous spot-gold close", async () => {
  const now = Date.now();
  const missesBefore = dukascopy.stats.misses;
  // Three calendar days back is at most three files, one download round: enough for the previous close.
  const days = aggregate(await dukascopy.minuteSeries("XAUUSD", now - 3 * DAY, now), DAY);
  return { value: days, ttlMs: days.length > 0 && dukascopy.stats.misses === missesBefore ? 10 * 60_000 : 30_000 };
});

/**
 * Recent daily candles for the quote (previous close, today's range). The quote must not depend on the
 * two-year daily history: on a new machine that takes minutes, these few files take seconds.
 */
async function recentDailyCandles(waitMs: number): Promise<Candle[]> {
  return mergeLive(await recentDays.get(waitMs), liveSampler.xauCandles(), DAY, DAY);
}

function spotSource(label: string, asOf: number, quality: DataSource["quality"], note: string, url?: string): DataSource {
  return { provider: "dukascopy+swissquote", label, fetchedAt: Date.now(), asOf, quality, proxy: false, note, url };
}

export class GoldSpotProvider implements CandleProvider, QuoteProvider {
  readonly id = "gold-spot";
  supports(assetId: AssetId): boolean {
    return assetId === "XAUUSD";
  }
  async getCandles(_assetId: AssetId, timeframe: Timeframe, limit: number, waitMs = REQUEST_WAIT_MS): Promise<CandleResult> {
    const candles = await getInstrumentCandles("XAUUSD", timeframe, limit, waitMs);
    if (!candles.length) throw new Error("No spot gold history available from Dukascopy");
    const last = candles[candles.length - 1];
    const now = Date.now();
    const open = isSpotMarketOpen(now);
    const expectedGap = Math.max(TIMEFRAME_MS[timeframe], 2 * HOUR);
    const quality: DataSource["quality"] = !open ? "closed" : now - last.time <= expectedGap + 30 * 60_000 ? "live" : "stale";
    return {
      candles,
      source: spotSource(
        "Spot XAU/USD — Dukascopy bid candles + Swissquote live sampling",
        last.time,
        quality,
        `Genuine OTC spot gold (not PAXG, not COMEX futures). History from the Dukascopy archive (bid side, UTC-aligned bars); the current hour is sampled from Swissquote's public quote feed. ${open ? "Market open." : "Spot market closed (trades Sun ~22:00 to Fri ~22:00 UTC); weekend gaps are real."}`,
        "https://www.dukascopy.com/swiss/english/marketwatch/historical/",
      ),
    };
  }
  async getQuote(assetId: AssetId): Promise<Quote> {
    const q = liveSampler.lastXau ?? (await getSwissquoteQuote("XAU/USD"));
    const now = Date.now();
    const age = now - q.ts;
    const open = isSpotMarketOpen(now);
    const quality: DataSource["quality"] = !open ? "closed" : age < 2 * 60_000 ? "live" : age < 20 * 60_000 ? "delayed" : "stale";
    // For the first seconds on a machine that has never downloaded gold data this throws WarmingError:
    // a price shown without its previous close would carry a made-up "0.00 %" change.
    const daily = await recentDailyCandles(REQUEST_WAIT_MS).catch((err: unknown) => {
      if (isWarming(err)) throw err;
      return [] as Candle[];
    });
    const today = daily.length && daily[daily.length - 1].time >= Math.floor(now / DAY) * DAY - (open ? 0 : 3 * DAY) ? daily[daily.length - 1] : null;
    const prevClose = daily.length >= 2 ? daily[daily.length - 2].close : (daily[0]?.open ?? q.mid);
    const changeBasis = daily.length >= 2 ? "Change is versus the previous UTC daily close from the Dukascopy archive." : "The previous close is unavailable (archive unreachable), so the change is not meaningful.";
    return {
      assetId,
      price: q.mid,
      change24h: q.mid - prevClose,
      changePct24h: prevClose ? ((q.mid - prevClose) / prevClose) * 100 : 0,
      high24h: today ? Math.max(today.high, q.mid) : undefined,
      low24h: today ? Math.min(today.low, q.mid) : undefined,
      source: {
        provider: "swissquote",
        label: "Spot XAU/USD — Swissquote public BBO (prime), mid of bid/ask",
        fetchedAt: now,
        asOf: q.ts,
        quality,
        proxy: false,
        note: `${open ? "Spot market open." : "Spot gold market closed (trades Sun ~22:00 to Fri ~22:00 UTC); showing the last quote."} Bid ${q.bid} / ask ${q.ask} (spread ${q.spread.toFixed(3)}). ${changeBasis}`,
        url: "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD",
      },
    };
  }
}

/** DXY history from the six constituent archives (bar closes, intersected on timestamp). */
async function loadDxyHistory(step: "1h" | "1d"): Promise<Loaded<SeriesPoint[]>> {
  const now = Date.now();
  const series = await Promise.all(
    DXY_PAIRS.map((pair) =>
      (step === "1d" ? dukascopy.dailySeries(pair, 2, now) : dukascopy.hourlySeries(pair, 2, now)).catch((err: Error) => {
        log.warn(`${pair} ${step} history failed: ${err.message}`);
        return [] as Candle[];
      }),
    ),
  );
  let points: SeriesPoint[] = [];
  if (!series.some((s) => s.length === 0)) {
    const maps = series.map((s) => new Map(s.map((c) => [c.time, c.close] as const)));
    const times = [...maps[0].keys()].filter((t) => maps.every((m) => m.has(t))).sort((a, b) => a - b);
    points = times.map((t) => ({ time: t, value: dxyFromRates({ EURUSD: maps[0].get(t)!, USDJPY: maps[1].get(t)!, GBPUSD: maps[2].get(t)!, USDCAD: maps[3].get(t)!, USDSEK: maps[4].get(t)!, USDCHF: maps[5].get(t)! }) }));
  }
  const last = points.length ? points[points.length - 1].time : 0;
  // A result whose latest point is not recent means a download failed: keep it for a minute only, so it heals.
  const complete = last > now - (step === "1d" ? 4 : 3) * DAY;
  if (!complete) log.warn(`DXY ${step} history incomplete (${points.length} points, last ${last ? new Date(last).toISOString() : "none"}); will retry in 60 s`);
  return { value: points, ttlMs: complete ? (step === "1d" ? 15 * 60_000 : 5 * 60_000) : 60_000 };
}

const dxySeries: Record<"1h" | "1d", WarmSeries<SeriesPoint[]>> = {
  "1h": new WarmSeries("US Dollar Index history", () => loadDxyHistory("1h")),
  "1d": new WarmSeries("US Dollar Index history", () => loadDxyHistory("1d")),
};

/** Like the gold series: waits at most `waitMs` on a cold cache, then fails with WarmingError. */
export function dxyHistory(step: "1h" | "1d", waitMs = REQUEST_WAIT_MS): Promise<SeriesPoint[]> {
  return dxySeries[step].get(waitMs);
}

// ---------------------------------------------------------------------------------------------------
// First-start warm-up
// ---------------------------------------------------------------------------------------------------

export interface WarmupStep {
  id: string;
  label: string;
  state: "pending" | "running" | "done" | "failed";
  ms: number | null;
  error?: string;
}

const warmup = { firstRun: false, startedAt: 0, finishedAt: 0, steps: [] as WarmupStep[] };

/** True when this machine has no downloaded gold history yet (a fresh clone, or a wiped data folder). */
function archiveCacheIsEmpty(): boolean {
  try {
    return fs.readdirSync(path.join(config.dataDir, "cache", "dukascopy", "XAUUSD")).length < 5;
  } catch {
    return true;
  }
}

/** Progress of the background download, for the first-start notice in the UI. */
export function getWarmupStatus() {
  return {
    warming: warmup.startedAt > 0 && warmup.finishedAt === 0,
    firstRun: warmup.firstRun,
    startedAt: warmup.startedAt || null,
    finishedAt: warmup.finishedAt || null,
    steps: warmup.steps.map((s) => ({ ...s })),
    files: dukascopy.progress(),
  };
}

/**
 * Loads everything the gold pages need in the background, most visible first: the quote, intraday
 * charts, hourly charts, daily history, then the dollar index. Request handlers never wait for this.
 */
export async function prewarm(): Promise<void> {
  const t0 = Date.now();
  const plan: [string, string, () => Promise<unknown>][] = [
    ["quote", "gold price", () => recentDailyCandles(Infinity)],
    ["intraday", "gold 5m and 15m charts", () => Promise.all([getInstrumentCandles("XAUUSD", "15m", 500, Infinity), getInstrumentCandles("XAUUSD", "5m", 500, Infinity)])],
    ["hourly", "gold 1h chart", () => getInstrumentCandles("XAUUSD", "1h", 600, Infinity)],
    ["daily", "gold daily and weekly history", () => Promise.all([getInstrumentCandles("XAUUSD", "1d", 500, Infinity), getInstrumentCandles("XAUUSD", "1w", 300, Infinity)])],
    ["hourly-deep", "gold 4h chart and deep hourly history", () => Promise.all([getInstrumentCandles("XAUUSD", "4h", 600, Infinity), getInstrumentCandles("XAUUSD", "1h", 1000, Infinity), getInstrumentCandles("XAUUSD", "4h", 1000, Infinity)])],
    ["dxy", "US Dollar Index history", () => Promise.all([dxyHistory("1h", Infinity), dxyHistory("1d", Infinity)])],
  ];
  warmup.firstRun = archiveCacheIsEmpty();
  warmup.startedAt = t0;
  warmup.finishedAt = 0;
  warmup.steps = plan.map(([id, label]) => ({ id, label, state: "pending", ms: null }));
  if (warmup.firstRun) log.info("first start on this machine: downloading spot-gold and FX history in the background (cached afterwards)");
  for (let i = 0; i < plan.length; i++) {
    const step = warmup.steps[i];
    const t = Date.now();
    step.state = "running";
    try {
      await plan[i][2]();
      step.state = "done";
      step.ms = Date.now() - t;
      log.info(`prewarm ${step.label} ok (${step.ms} ms)`);
    } catch (err) {
      step.state = "failed";
      step.ms = Date.now() - t;
      step.error = (err as Error).message;
      log.warn(`prewarm ${step.label} failed: ${step.error}`);
    }
  }
  warmup.finishedAt = Date.now();
  log.info(`prewarm finished in ${Math.round((warmup.finishedAt - t0) / 1000)} s`);
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
  /** True while the archive history is still being downloaded for the first time (only the live value is available). */
  historyWarming: boolean;
}

export async function getDxy(waitMs = REQUEST_WAIT_MS): Promise<DxyData> {
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
  // Append live hourly closes for hours the archive has not published.
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
      note: `DXY = 50.14348112 × EURUSD^-0.576 × USDJPY^0.136 × GBPUSD^-0.119 × USDCAD^0.091 × USDSEK^0.042 × USDCHF^0.036, computed from bank quotes of the six constituents. It is the index definition itself, not the licensed ICE Data Services print, so it can differ from the ICE value by a few hundredths. ${open ? "FX market open." : "FX market closed; showing the last quotes."}${historyWarming ? " The history is still being downloaded for the first time on this machine; only the live value is available yet." : ""}`,
      url: "https://www.theice.com/products/194/US-Dollar-Index-Futures",
    },
  };
}

export interface GoldVerification {
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

/** Archive-only hourly bars for the verification row: never mixed with the live sampler. */
const archiveHourly = new WarmSeries<Candle[]>("The spot-gold archive", async () => {
  const hours = (await dukascopy.hourlySeries("XAUUSD", 1, Date.now())).filter((c) => c.volume > 0);
  return { value: hours, ttlMs: hours.length ? 60_000 : 30_000 };
});

export async function getGoldVerification(): Promise<GoldVerification> {
  const cached = cache.get<GoldVerification>("gold:verification");
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const now = Date.now();
  const open = isSpotMarketOpen(now);
  const notes: string[] = [];
  let warming = false;
  const [sq, ga, h1, dxy, synth, td] = await Promise.allSettled([
    liveSampler.lastXau ? Promise.resolve(liveSampler.lastXau) : getSwissquoteQuote("XAU/USD"),
    getGoldApiPrice(),
    archiveHourly.get(REQUEST_WAIT_MS),
    getDxy(),
    getSyntheticDxy(10),
    config.hasTwelveData ? import("../providers/gold").then((m) => new m.TwelveDataGoldProvider().getQuote("XAUUSD")) : Promise.resolve(null),
  ]);
  const v = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
  if (h1.status === "rejected" && isWarming(h1.reason)) warming = true;
  const sqq = v(sq);
  const gaq = v(ga);
  const hh = v(h1) ?? [];
  const dd = v(dxy);
  if (dd?.historyWarming) warming = true;
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
  const spotStatus = spotDev === null ? "insufficient" : spotDev <= 0.5 ? "verified" : "divergent";
  if (warming) notes.push("The Dukascopy archive is still being downloaded for the first time on this machine, so its rows are missing for now.");
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
  const result: GoldVerification = {
    checkedAt: now,
    marketOpen: open,
    warming,
    spot: {
      swissquote: sqq ? { price: sqq.mid, ts: sqq.ts } : null,
      goldApi: gaq,
      dukascopyLastClose: lastHour ? { price: lastHour.close, ts: lastHour.time + HOUR } : null,
      twelveData: tdq ? { price: tdq.price, ts: tdq.source.asOf } : null,
      maxDeviationPct: spotDev,
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
  // While the archive is still downloading the result is refreshed quickly instead of being kept for a minute.
  cache.set("gold:verification", result, warming ? 5_000 : 60_000);
  return result;
}

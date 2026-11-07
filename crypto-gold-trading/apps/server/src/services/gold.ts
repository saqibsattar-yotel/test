/**
 * Gold & dollar-index data service.
 *  - Spot XAU/USD: Dukascopy archive (history, bid side) + Swissquote live quotes sampled into
 *    minute candles for the current hour. Never a tokenised proxy, never a futures contract.
 *  - US Dollar Index: the ICE formula applied to the six constituent FX rates — history from the
 *    Dukascopy FX archive, live value from Swissquote. (Dukascopy's "USDIDX" instrument was probed
 *    and found to be a flat placeholder, so it is not used.)
 *  - Verification: Swissquote vs gold-api.com vs Dukascopy vs Twelve Data (if keyed).
 */
import type { AssetId, Candle, DataSource, Quote, Timeframe } from "@terminal/core";
import { TIMEFRAME_MS } from "@terminal/core";
import { config } from "../config";
import { cache } from "../lib/cache";
import { logger } from "../lib/logger";
import { JsonStore } from "../lib/store";
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

/** Spot XAU/USD candles at a terminal timeframe: Dukascopy archive merged with live sampling. */
export async function getInstrumentCandles(instrument: "XAUUSD", timeframe: Timeframe, limit: number): Promise<Candle[]> {
  const key = `duka:${instrument}:${timeframe}:${limit}`;
  const ttl = timeframe === "1d" || timeframe === "1w" ? 15 * 60_000 : timeframe === "4h" ? 5 * 60_000 : 60_000;
  const res = await cache.getOrLoad<Candle[]>(key, ttl, async () => {
    const now = Date.now();
    const bucket = TIMEFRAME_MS[timeframe];
    let history: Candle[];
    let step: number;
    if (timeframe === "1d" || timeframe === "1w") {
      history = await dukascopy.dailySeries(instrument, 2, now);
      step = DAY;
    } else if (timeframe === "1h" || timeframe === "4h") {
      history = await dukascopy.hourlySeries(instrument, Math.min(12, Math.ceil((limit * bucket) / (30 * DAY)) + 1), now);
      step = HOUR;
    } else {
      history = await dukascopy.minuteSeries(instrument, now - Math.max(3, Math.ceil((limit * bucket) / DAY) + 2) * DAY, now);
      step = 60_000;
    }
    const merged = mergeLive(history, liveSampler.xauCandles(), bucket === 7 * DAY ? DAY : bucket, step);
    const series = bucket === 7 * DAY ? aggregateWeekly(merged) : merged;
    return series.slice(-limit);
  });
  return res.value;
}

function spotSource(label: string, asOf: number, quality: DataSource["quality"], note: string, url?: string): DataSource {
  return { provider: "dukascopy+swissquote", label, fetchedAt: Date.now(), asOf, quality, proxy: false, note, url };
}

export class GoldSpotProvider implements CandleProvider, QuoteProvider {
  readonly id = "gold-spot";
  supports(assetId: AssetId): boolean {
    return assetId === "XAUUSD";
  }
  async getCandles(_assetId: AssetId, timeframe: Timeframe, limit: number): Promise<CandleResult> {
    const candles = await getInstrumentCandles("XAUUSD", timeframe, limit);
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
    const daily = await getInstrumentCandles("XAUUSD", "1d", 3).catch(() => [] as Candle[]);
    const today = daily.length && daily[daily.length - 1].time >= Math.floor(now / DAY) * DAY - (open ? 0 : 3 * DAY) ? daily[daily.length - 1] : null;
    const prevClose = daily.length >= 2 ? daily[daily.length - 2].close : (daily[0]?.open ?? q.mid);
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
        note: `${open ? "Spot market open." : "Spot gold market closed (trades Sun ~22:00 to Fri ~22:00 UTC); showing the last quote."} Bid ${q.bid} / ask ${q.ask} (spread ${q.spread.toFixed(3)}). Change is versus the previous UTC daily close from the Dukascopy archive.`,
        url: "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD",
      },
    };
  }
}

const dxyInflight = new Map<string, Promise<SeriesPoint[]>>();

/**
 * DXY history from the six constituent archives (bar closes, intersected on timestamp). A result whose
 * latest point is not recent (an archive download failed) is cached for one minute only, so it heals.
 */
export async function dxyHistory(step: "1h" | "1d"): Promise<SeriesPoint[]> {
  const key = `dxy:hist:${step}`;
  const hit = cache.get<SeriesPoint[]>(key);
  if (hit) return hit.value;
  const inflight = dxyInflight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
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
    const complete = last > now - (step === "1d" ? 4 : 3) * DAY;
    cache.set(key, points, complete ? (step === "1d" ? 15 * 60_000 : 5 * 60_000) : 60_000);
    if (!complete) log.warn(`DXY ${step} history incomplete (${points.length} points, last ${last ? new Date(last).toISOString() : "none"}); will retry in 60 s`);
    return points;
  })().finally(() => dxyInflight.delete(key));
  dxyInflight.set(key, p);
  return p;
}

/** Load the series the Gold page and macro layer need, one after another, so the first visitor never triggers a burst. */
export async function prewarm(): Promise<void> {
  const t0 = Date.now();
  const steps: [string, () => Promise<unknown>][] = [
    ["XAUUSD 1d", () => getInstrumentCandles("XAUUSD", "1d", 600)],
    ["XAUUSD 1h", () => getInstrumentCandles("XAUUSD", "1h", 600)],
    ["XAUUSD 15m", () => getInstrumentCandles("XAUUSD", "15m", 600)],
    ["XAUUSD 4h", () => getInstrumentCandles("XAUUSD", "4h", 600)],
    ["DXY 1d", () => dxyHistory("1d")],
    ["DXY 1h", () => dxyHistory("1h")],
  ];
  for (const [name, fn] of steps) {
    const t = Date.now();
    try {
      await fn();
      log.info(`prewarm ${name} ok (${Date.now() - t} ms)`);
    } catch (err) {
      log.warn(`prewarm ${name} failed: ${(err as Error).message}`);
    }
  }
  log.info(`prewarm finished in ${Math.round((Date.now() - t0) / 1000)} s`);
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
}

export async function getDxy(): Promise<DxyData> {
  const now = Date.now();
  const [d1, h1] = await Promise.all([dxyHistory("1d"), dxyHistory("1h")]);
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
    source: {
      provider: "dukascopy+swissquote",
      label: "US Dollar Index — ICE formula on live Swissquote FX (now) and the Dukascopy FX archive (history)",
      fetchedAt: now,
      asOf: ts,
      quality,
      proxy: false,
      note: `DXY = 50.14348112 × EURUSD^-0.576 × USDJPY^0.136 × GBPUSD^-0.119 × USDCAD^0.091 × USDSEK^0.042 × USDCHF^0.036, computed from bank quotes of the six constituents. It is the index definition itself, not the licensed ICE Data Services print, so it can differ from the ICE value by a few hundredths. ${open ? "FX market open." : "FX market closed; showing the last quotes."}`,
      url: "https://www.theice.com/products/194/US-Dollar-Index-Futures",
    },
  };
}

export interface GoldVerification {
  checkedAt: number;
  marketOpen: boolean;
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

export async function getGoldVerification(): Promise<GoldVerification> {
  const res = await cache.getOrLoad<GoldVerification>("gold:verification", 60_000, async () => {
    const now = Date.now();
    const open = isSpotMarketOpen(now);
    const notes: string[] = [];
    const [sq, ga, h1, dxy, synth, td] = await Promise.allSettled([
      liveSampler.lastXau ? Promise.resolve(liveSampler.lastXau) : getSwissquoteQuote("XAU/USD"),
      getGoldApiPrice(),
      dukascopy.hourlySeries("XAUUSD", 1, now), // archive only — never mixed with the live sampler
      getDxy(),
      getSyntheticDxy(10),
      config.hasTwelveData ? import("../providers/gold").then((m) => new m.TwelveDataGoldProvider().getQuote("XAUUSD")) : Promise.resolve(null),
    ]);
    const v = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
    const sqq = v(sq);
    const gaq = v(ga);
    const hh = (v(h1) ?? []).filter((c) => c.volume > 0);
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
    const spotStatus = spotDev === null ? "insufficient" : spotDev <= 0.5 ? "verified" : "divergent";
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
    return {
      checkedAt: now,
      marketOpen: open,
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
  });
  return res.value;
}

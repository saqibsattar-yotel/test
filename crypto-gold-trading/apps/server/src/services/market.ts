/**
 * Unified market-data service. Providers are tried in order; results are cached with
 * stale-while-error semantics; when everything fails and demo mode allows it, an
 * explicit DEMO payload is returned (quality: "demo") so the UI can say so.
 */
import type { AssetId, Candle, DataSource, Quote, Timeframe } from "@terminal/core";
import { ASSETS, CRYPTO_ASSETS, demoCandles, demoSource, resolveAsset, startOfUtcDay } from "@terminal/core";
import { config } from "../config";
import { cache } from "../lib/cache";
import { logger } from "../lib/logger";
import { JsonStore } from "../lib/store";
import { isWarming } from "../lib/warming";
import { BinanceFuturesProvider, BinanceSpotProvider } from "../providers/binance";
import { BybitProvider, CoinbaseProvider } from "../providers/fallbacks";
import { getGlobal, getTopCoins, STABLE_OR_WRAPPED, type CoinMarket, type GlobalMarket } from "../providers/coingecko";
import { getFearGreed, type FearGreed } from "../providers/sentiment";
import { TwelveDataGoldProvider } from "../providers/gold";
import { GoldSpotProvider, getDxy, getInstrumentCandles } from "./gold";
import { getFredSeries, getRealYields, getSyntheticDxy, getTreasuryYields, type MacroSeries } from "../providers/macro";
import type { CandleProvider, CandleResult, DerivativesProvider, FundingInfo, OpenInterestInfo, QuoteProvider } from "../providers/types";

const log = logger("market");

export const CANDLE_LIMITS: Record<Timeframe, number> = { "5m": 500, "15m": 500, "1h": 1000, "4h": 1000, "1d": 500, "1w": 300 };
const CANDLE_TTL: Record<Timeframe, number> = { "5m": 30_000, "15m": 60_000, "1h": 120_000, "4h": 300_000, "1d": 900_000, "1w": 3_600_000 };

export interface CandlePayload extends CandleResult {
  assetId: AssetId;
  timeframe: Timeframe;
  warnings: string[];
}

export interface DominanceHistory {
  observations: { date: string; dominance: number }[];
}

export class MarketDataService {
  private binance = new BinanceSpotProvider();
  private binanceFutures = new BinanceFuturesProvider();
  private bybit = new BybitProvider();
  private coinbase = new CoinbaseProvider();
  private twelve = new TwelveDataGoldProvider();
  private goldSpot = new GoldSpotProvider();
  private dominanceStore = new JsonStore<DominanceHistory>("dominance-history", () => ({ observations: [] }));

  private candleChain(assetId: AssetId): CandleProvider[] {
    if (assetId === "XAUUSD") return [this.twelve, this.goldSpot].filter((p) => p.supports(assetId));
    return [this.binance, this.bybit, this.coinbase].filter((p) => p.supports(assetId));
  }
  private quoteChain(assetId: AssetId): QuoteProvider[] {
    if (assetId === "XAUUSD") return [this.twelve, this.goldSpot].filter((p) => p.supports(assetId));
    return [this.binance, this.bybit, this.coinbase].filter((p) => p.supports(assetId));
  }

  async getCandles(assetId: AssetId, timeframe: Timeframe, limit = CANDLE_LIMITS[timeframe]): Promise<CandlePayload> {
    const key = `candles:${assetId}:${timeframe}:${limit}`;
    const warnings: string[] = [];
    if (config.DEMO_MODE === "force") return { ...this.demoCandles(assetId, timeframe, limit), assetId, timeframe, warnings: ["Demo mode forced by configuration"] };
    try {
      const res = await cache.getOrLoad<CandleResult>(key, CANDLE_TTL[timeframe], async () => {
        let lastErr: unknown;
        for (const p of this.candleChain(assetId)) {
          try {
            const r = await p.getCandles(assetId, timeframe, limit);
            if (r.candles.length === 0) throw new Error("empty candle set");
            return r;
          } catch (err) {
            if (isWarming(err)) throw err; // first-start download in progress: not a provider failure
            lastErr = err;
            log.warn(`${p.id} candles failed for ${assetId} ${timeframe}: ${(err as Error).message}`);
          }
        }
        throw lastErr instanceof Error ? lastErr : new Error("all candle providers failed");
      });
      if (res.stale) warnings.push(`Serving cached candles from ${new Date(res.storedAt).toISOString()} — refresh failed: ${res.error}`);
      const source: DataSource = res.stale ? { ...res.value.source, quality: "stale", note: `${res.value.source.note ?? ""} Cached copy; upstream refresh failed.`.trim() } : res.value.source;
      return { candles: res.value.candles, source, assetId, timeframe, warnings };
    } catch (err) {
      // Data that is merely still downloading is never replaced by demo data: the caller retries.
      if (isWarming(err)) throw err;
      if (config.DEMO_MODE === "off") throw err;
      log.error(`All providers failed for ${assetId} ${timeframe}; serving DEMO data`, err);
      return { ...this.demoCandles(assetId, timeframe, limit, (err as Error).message), assetId, timeframe, warnings: [`Live data unavailable (${(err as Error).message}). Showing DEMO data.`] };
    }
  }

  /** Up to `bars` candles (max 3000) by paging backwards; used by the backtester. */
  async getCandlesExtended(assetId: AssetId, timeframe: Timeframe, bars: number): Promise<CandlePayload> {
    if (assetId === "XAUUSD" && !config.hasTwelveData && config.DEMO_MODE !== "force") {
      // A backtest is an explicit, long-running request: wait for the archive (bounded) rather than
      // answering "still downloading" after a couple of seconds.
      const r = await this.goldSpot.getCandles(assetId, timeframe, bars, 90_000);
      return { ...r, assetId, timeframe, warnings: [], source: { ...r.source, note: `${r.source.note ?? ""} Extended history from the Dukascopy archive (${r.candles.length} bars).`.trim() } };
    }
    const first = await this.getCandles(assetId, timeframe, Math.min(1000, bars));
    if (first.source.quality === "demo" || first.candles.length >= bars) return first;
    if (assetId === "XAUUSD") {
      if (first.source.provider === "twelvedata") return first;
      const candles = await getInstrumentCandles("XAUUSD", timeframe, bars);
      return { ...first, candles, source: { ...first.source, note: `${first.source.note ?? ""} Extended history from the Dukascopy archive (${candles.length} bars).`.trim() } };
    }
    const key = `candles-ext:${assetId}:${timeframe}:${bars}`;
    const res = await cache.getOrLoad<Candle[]>(key, 30 * 60_000, async () => {
      let all = [...first.candles];
      let guard = 0;
      while (all.length < bars && guard++ < 4) {
        const oldest = all[0].time;
        const page = await this.binance.getCandlesBefore(assetId, timeframe, oldest, Math.min(1000, bars - all.length));
        if (!page.length) break;
        all = [...page.filter((c) => c.time < oldest), ...all];
      }
      return all.slice(-bars);
    });
    return { ...first, candles: res.value, source: { ...first.source, note: `${first.source.note ?? ""} Extended history paged from the provider (${res.value.length} bars).`.trim() } };
  }

  private demoCandles(assetId: AssetId, timeframe: Timeframe, limit: number, reason?: string): CandleResult {
    const now = Date.now();
    const src = demoSource(`${resolveAsset(assetId).symbol} ${timeframe} candles`, now);
    if (reason) src.note = `${src.note} Reason: ${reason}`;
    return { candles: demoCandles(assetId, timeframe, limit, now), source: src };
  }

  async getQuotes(assetIds: AssetId[]): Promise<Quote[]> {
    if (config.DEMO_MODE === "force") return assetIds.map((a) => this.demoQuote(a));
    const key = `quotes:${assetIds.slice().sort().join(",")}`;
    try {
      const res = await cache.getOrLoad<{ quotes: Quote[]; warming: AssetId[] }>(key, 5_000, async () => {
        const out: Quote[] = [];
        const warming: AssetId[] = [];
        const crypto = assetIds.filter((a) => a !== "XAUUSD");
        if (crypto.length) {
          try {
            out.push(...(await this.binance.getQuotes(crypto)));
          } catch (err) {
            log.warn(`binance batch quotes failed: ${(err as Error).message}`);
            for (const a of crypto) {
              const q = await this.quoteWithFallback(a).catch(() => null);
              if (q) out.push(q);
            }
          }
        }
        if (assetIds.includes("XAUUSD")) {
          try {
            out.push(await this.quoteWithFallback("XAUUSD"));
          } catch (err) {
            if (isWarming(err)) warming.push("XAUUSD");
          }
        }
        if (out.length === 0 && warming.length === 0) throw new Error("no quotes from any provider");
        return { quotes: out, warming };
      });
      const quotes = res.value.quotes.map((q) => (res.stale ? { ...q, source: { ...q.source, quality: "stale" as const } } : q));
      // Fill in any asset that is missing with demo (auto) or omit (off). An asset whose data is still being
      // downloaded for the first time is left out instead: it is not unavailable, and a demo price would mislead.
      if (config.DEMO_MODE === "auto") for (const a of assetIds) if (!quotes.some((q) => q.assetId === a) && !res.value.warming.includes(a)) quotes.push(this.demoQuote(a));
      return quotes;
    } catch (err) {
      if (config.DEMO_MODE === "off") throw err;
      return assetIds.map((a) => this.demoQuote(a, (err as Error).message));
    }
  }

  private async quoteWithFallback(assetId: AssetId): Promise<Quote> {
    let lastErr: unknown;
    for (const p of this.quoteChain(assetId)) {
      try {
        return await p.getQuote(assetId);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("quote providers failed");
  }

  private demoQuote(assetId: AssetId, reason?: string): Quote {
    const now = Date.now();
    const c = demoCandles(assetId, "1h", 30, now);
    const last = c[c.length - 1];
    const first = c[c.length - 25];
    const src = demoSource(`${resolveAsset(assetId).symbol} quote`, now);
    if (reason) src.note = `${src.note} Reason: ${reason}`;
    return { assetId, price: last.close, change24h: last.close - first.close, changePct24h: ((last.close - first.close) / first.close) * 100, high24h: Math.max(...c.slice(-24).map((x) => x.high)), low24h: Math.min(...c.slice(-24).map((x) => x.low)), source: src };
  }

  async getFunding(assetIds: AssetId[] = CRYPTO_ASSETS): Promise<{ funding: FundingInfo[]; source: DataSource | null; error?: string }> {
    const key = `funding:${assetIds.slice().sort().join(",")}`;
    try {
      const res = await cache.getOrLoad<FundingInfo[]>(key, 60_000, async () => {
        const chain: DerivativesProvider[] = [this.binanceFutures, this.bybit];
        let lastErr: unknown;
        for (const p of chain) {
          try {
            return await p.getFunding(assetIds);
          } catch (err) {
            lastErr = err;
          }
        }
        throw lastErr instanceof Error ? lastErr : new Error("funding providers failed");
      });
      return { funding: res.value, source: res.value[0]?.source ?? null, error: res.error };
    } catch (err) {
      return { funding: [], source: null, error: (err as Error).message };
    }
  }

  async getOpenInterest(assetId: AssetId): Promise<OpenInterestInfo | { error: string }> {
    try {
      const res = await cache.getOrLoad<OpenInterestInfo>(`oi:${assetId}`, 120_000, async () => {
        try {
          return await this.binanceFutures.getOpenInterest(assetId);
        } catch {
          return await this.bybit.getOpenInterest(assetId);
        }
      });
      return res.value;
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  async getGlobal(): Promise<GlobalMarket | { error: string }> {
    try {
      const res = await cache.getOrLoad<GlobalMarket>("coingecko:global", 180_000, getGlobal);
      if (!res.fromCache) void this.recordDominance(res.value.btcDominancePct);
      return res.stale ? { ...res.value, source: { ...res.value.source, quality: "stale" } } : res.value;
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  private async recordDominance(value: number) {
    const date = new Date(startOfUtcDay(Date.now())).toISOString().slice(0, 10);
    await this.dominanceStore.update((h) => {
      const idx = h.observations.findIndex((o) => o.date === date);
      if (idx >= 0) h.observations[idx].dominance = value;
      else h.observations.push({ date, dominance: value });
      h.observations.sort((a, b) => a.date.localeCompare(b.date));
      return h;
    });
  }

  async getDominanceHistory(): Promise<number[]> {
    const h = await this.dominanceStore.load();
    return h.observations.map((o) => o.dominance);
  }

  async getTopCoins(): Promise<{ coins: CoinMarket[]; source: DataSource } | { error: string }> {
    try {
      const res = await cache.getOrLoad("coingecko:markets", 300_000, () => getTopCoins(40));
      return res.value;
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  async getFearGreed(): Promise<FearGreed | { error: string }> {
    try {
      const res = await cache.getOrLoad<FearGreed>("fng", 600_000, getFearGreed);
      return res.value;
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /** Alt universe (top coins by market cap, ex-stables/wrapped) daily closes for breadth. */
  async getAltUniverseDaily(): Promise<{ series: Record<string, number[]>; weights: Record<string, number>; note: string }> {
    const top = await this.getTopCoins();
    const fallbackSymbols = CRYPTO_ASSETS.filter((a) => a !== "BTCUSD").map((a) => ASSETS[a].base);
    let symbols: { symbol: string; mcap: number }[];
    if ("error" in top) symbols = fallbackSymbols.map((s) => ({ symbol: s, mcap: 1 }));
    else symbols = top.coins.filter((c) => c.symbol !== "BTC" && !STABLE_OR_WRAPPED.has(c.symbol)).slice(0, 15).map((c) => ({ symbol: c.symbol, mcap: c.marketCapUsd }));
    const series: Record<string, number[]> = {};
    const weights: Record<string, number> = {};
    const results = await Promise.allSettled(
      symbols.map(async ({ symbol }) => {
        const key = `altcloses:${symbol}`;
        const res = await cache.getOrLoad<number[]>(key, 3_600_000, async () => {
          const raw = await (await import("../lib/http")).fetchJson<unknown[][]>(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1d&limit=420`);
          return raw.map((k) => parseFloat(String(k[4])));
        });
        return { symbol, closes: res.value };
      }),
    );
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value.closes.length >= 31) {
        series[r.value.symbol] = r.value.closes;
        weights[r.value.symbol] = symbols[i].mcap;
      }
    });
    return { series, weights, note: `${Object.keys(series).length} alts from CoinGecko top-40 (ex-stables/wrapped) with Binance daily closes` };
  }

  async getMacro(): Promise<{ dxy: MacroSeries | null; dgs10: MacroSeries | null; dgs2: MacroSeries | null; real10: MacroSeries | null; curve: MacroSeries | null; errors: string[] }> {
    const errors: string[] = [];
    const wrap = async <T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T | null> => {
      try {
        return (await cache.getOrLoad(key, ttl, fn)).value;
      } catch (err) {
        errors.push(`${key}: ${(err as Error).message}`);
        return null;
      }
    };
    const sixHours = 6 * 3_600_000;
    if (config.hasFred) {
      const [dgs10, dgs2, real10, dxy] = await Promise.all([
        wrap("fred:DGS10", sixHours, () => getFredSeries("DGS10", "US 10-year Treasury yield", "%")),
        wrap("fred:DGS2", sixHours, () => getFredSeries("DGS2", "US 2-year Treasury yield", "%")),
        wrap("fred:DFII10", sixHours, () => getFredSeries("DFII10", "US 10-year real yield (TIPS)", "%")),
        wrap("fred:DTWEXBGS", sixHours, () => getFredSeries("DTWEXBGS", "Nominal Broad US Dollar Index (FRED)", "index")),
      ]);
      const curve = dgs10 && dgs2 ? spreadSeries(dgs10, dgs2) : null;
      const realDxy = await getDxy().catch(() => null);
      if (realDxy && realDxy.history1d.length > 20) {
        const points = realDxy.history1d.map((c) => ({ date: new Date(c.time).toISOString().slice(0, 10), value: c.value }));
        const latest = points[points.length - 1].value;
        return { dxy: { id: "DXY", label: "US Dollar Index (DXY)", unit: "index", points, latest, change1d: points.length > 1 ? latest - points[points.length - 2].value : null, change20d: points.length > 20 ? latest - points[points.length - 21].value : null, source: realDxy.source }, dgs10, dgs2, real10, curve, errors };
      }
      return { dxy: dxy ?? (await wrap("dxy:synthetic", sixHours, () => getSyntheticDxy())), dgs10, dgs2, real10, curve, errors };
    }
    const [yields, real10, realDxy] = await Promise.all([wrap("treasury:yields", sixHours, getTreasuryYields), wrap("treasury:real", sixHours, getRealYields), getDxy().catch((err) => (errors.push(`dxy: ${(err as Error).message}`), null))]);
    let dxy: MacroSeries | null = null;
    if (realDxy && realDxy.history1d.length > 20) {
      const points = realDxy.history1d.map((c) => ({ date: new Date(c.time).toISOString().slice(0, 10), value: c.value }));
      const liveDate = new Date(realDxy.ts).toISOString().slice(0, 10);
      if (Number.isFinite(realDxy.value) && points[points.length - 1]?.date !== liveDate) points.push({ date: liveDate, value: realDxy.value });
      const latest = points[points.length - 1].value;
      dxy = { id: "DXY", label: "US Dollar Index (DXY)", unit: "index", points, latest, change1d: points.length > 1 ? latest - points[points.length - 2].value : null, change20d: points.length > 20 ? latest - points[points.length - 21].value : null, source: realDxy.source };
    } else dxy = await wrap("dxy:synthetic", sixHours, () => getSyntheticDxy());
    return { dxy, dgs10: yields?.dgs10 ?? null, dgs2: yields?.dgs2 ?? null, real10, curve: yields?.curve2s10s ?? null, errors };
  }

  async getExchangeFilters(assetId: AssetId) {
    try {
      return (await cache.getOrLoad(`filters:${assetId}`, 24 * 3_600_000, () => this.binance.getExchangeFilters(assetId))).value;
    } catch {
      return null;
    }
  }
}

function spreadSeries(a: MacroSeries, b: MacroSeries): MacroSeries {
  const bm = new Map(b.points.map((p) => [p.date, p.value]));
  const points = a.points.filter((p) => bm.has(p.date)).map((p) => ({ date: p.date, value: p.value - (bm.get(p.date) as number) }));
  const latest = points[points.length - 1]?.value ?? NaN;
  return { id: "T10Y2Y", label: "2s10s curve", unit: "pp", points, latest, change1d: points.length > 1 ? latest - points[points.length - 2].value : null, change20d: points.length > 20 ? latest - points[points.length - 21].value : null, source: a.source };
}

export const market = new MarketDataService();
export type { Candle, FundingInfo, OpenInterestInfo, MacroSeries };

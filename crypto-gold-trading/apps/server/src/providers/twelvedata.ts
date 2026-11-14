/**
 * Twelve Data (API key): genuine spot quotes and history for the precious metals, XAU/USD and
 * XAG/USD. Optional: without a key the keyless metals service (Dukascopy archive + Swissquote) is
 * used on its own. With a key Twelve Data is tried first and the keyless service is the fallback,
 * for example when a plan does not include one of the two symbols.
 */
import type { AssetId, Candle, DataSource, Quote, Timeframe } from "@terminal/core";
import { METALS, isMetalAsset, type MetalInfo } from "@terminal/core";
import { config } from "../config";
import { fetchJson } from "../lib/http";
import type { CandleProvider, CandleResult, QuoteProvider } from "./types";
import { ProviderError } from "./types";

const TD = "https://api.twelvedata.com";
const TD_INTERVALS: Record<Timeframe, string> = { "5m": "5min", "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1day", "1w": "1week" };

interface TdBar {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

/** Twelve Data uses the pair ("XAU/USD", "XAG/USD") as its symbol. */
function metalOf(assetId: AssetId): MetalInfo {
  if (!isMetalAsset(assetId)) throw new ProviderError("twelvedata", `${assetId} is not a spot metal`);
  return METALS[assetId];
}

export class TwelveDataMetalProvider implements CandleProvider, QuoteProvider {
  readonly id = "twelvedata";
  supports(assetId: AssetId): boolean {
    return isMetalAsset(assetId) && config.hasTwelveData;
  }
  async getCandles(assetId: AssetId, timeframe: Timeframe, limit: number): Promise<CandleResult> {
    const { pair, metal } = metalOf(assetId);
    const url = `${TD}/time_series?symbol=${pair}&interval=${TD_INTERVALS[timeframe]}&outputsize=${Math.min(5000, limit)}&timezone=UTC&apikey=${config.TWELVEDATA_API_KEY}`;
    const res = await fetchJson<{ status?: string; message?: string; values?: TdBar[] }>(url);
    if (res.status === "error" || !res.values) throw new ProviderError(this.id, res.message ?? "no values");
    const candles: Candle[] = res.values
      .map((b) => ({ time: Date.parse(`${b.datetime.replace(" ", "T")}Z`), open: parseFloat(b.open), high: parseFloat(b.high), low: parseFloat(b.low), close: parseFloat(b.close), volume: b.volume ? parseFloat(b.volume) : 0 }))
      .filter((c) => Number.isFinite(c.time))
      .sort((a, b) => a.time - b.time);
    const source: DataSource = { provider: "twelvedata", label: `Twelve Data ${pair} spot`, fetchedAt: Date.now(), asOf: candles.length ? candles[candles.length - 1].time : Date.now(), quality: "live", url: url.replace(config.TWELVEDATA_API_KEY, "***"), note: `Spot ${metal} aggregated from FX liquidity providers. Volume is not meaningful for OTC spot ${metal}. Free-tier quotes may be delayed.` };
    return { candles, source };
  }
  async getQuote(assetId: AssetId): Promise<Quote> {
    const { pair } = metalOf(assetId);
    const url = `${TD}/quote?symbol=${pair}&apikey=${config.TWELVEDATA_API_KEY}`;
    const q = await fetchJson<Record<string, string | number | undefined> & { status?: string; message?: string }>(url);
    if (q.status === "error") throw new ProviderError(this.id, String(q.message));
    const price = parseFloat(String(q.close));
    if (!Number.isFinite(price)) throw new ProviderError(this.id, "quote missing close");
    return {
      assetId,
      price,
      change24h: parseFloat(String(q.change ?? 0)),
      changePct24h: parseFloat(String(q.percent_change ?? 0)),
      high24h: parseFloat(String(q.high ?? NaN)),
      low24h: parseFloat(String(q.low ?? NaN)),
      source: { provider: "twelvedata", label: `Twelve Data ${pair} quote`, fetchedAt: Date.now(), asOf: Number(q.timestamp) ? Number(q.timestamp) * 1000 : Date.now(), quality: "live", url: url.replace(config.TWELVEDATA_API_KEY, "***"), note: "Change is versus the previous session close, not a rolling 24h window." },
    };
  }
}

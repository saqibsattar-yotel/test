/**
 * Fallback crypto providers used when Binance is unreachable (outage or geo-block).
 * Bybit: klines + tickers + funding/OI. Coinbase Exchange: spot candles + ticker.
 */
import type { AssetId, Candle, DataSource, Quote, Timeframe } from "@terminal/core";
import { assetBase } from "@terminal/core";
import { fetchJson } from "../lib/http";
import type { CandleProvider, CandleResult, DerivativesProvider, FundingInfo, OpenInterestInfo, QuoteProvider } from "./types";
import { ProviderError } from "./types";

const BYBIT = "https://api.bybit.com";
const BYBIT_INTERVALS: Record<Timeframe, string> = { "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D", "1w": "W" };

export class BybitProvider implements CandleProvider, QuoteProvider, DerivativesProvider {
  readonly id = "bybit";
  private symbol(assetId: AssetId) {
    return `${assetBase(assetId)}USDT`;
  }
  supports(assetId: AssetId): boolean {
    return assetId !== "XAUUSD";
  }
  async getCandles(assetId: AssetId, timeframe: Timeframe, limit: number): Promise<CandleResult> {
    const symbol = this.symbol(assetId);
    const url = `${BYBIT}/v5/market/kline?category=spot&symbol=${symbol}&interval=${BYBIT_INTERVALS[timeframe]}&limit=${Math.min(1000, limit)}`;
    const res = await fetchJson<{ retCode: number; retMsg: string; result: { list: string[][] } }>(url);
    if (res.retCode !== 0) throw new ProviderError(this.id, res.retMsg);
    const candles: Candle[] = res.result.list.map((k) => ({ time: Number(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) })).sort((a, b) => a.time - b.time);
    const source: DataSource = { provider: "bybit", label: `Bybit spot ${symbol}`, fetchedAt: Date.now(), asOf: candles.length ? candles[candles.length - 1].time : Date.now(), quality: "live", proxy: false, url, note: "Fallback provider (Binance unavailable)." };
    return { candles, source };
  }
  async getQuote(assetId: AssetId): Promise<Quote> {
    const symbol = this.symbol(assetId);
    const url = `${BYBIT}/v5/market/tickers?category=spot&symbol=${symbol}`;
    const res = await fetchJson<{ retCode: number; result: { list: Record<string, string>[] } }>(url);
    const t = res.result?.list?.[0];
    if (!t) throw new ProviderError(this.id, "no ticker");
    const price = parseFloat(t.lastPrice);
    const prev = parseFloat(t.prevPrice24h);
    return { assetId, price, change24h: price - prev, changePct24h: parseFloat(t.price24hPcnt) * 100, high24h: parseFloat(t.highPrice24h), low24h: parseFloat(t.lowPrice24h), volume24hBase: parseFloat(t.volume24h), volume24hQuote: parseFloat(t.turnover24h), source: { provider: "bybit", label: `Bybit spot ${symbol} ticker`, fetchedAt: Date.now(), asOf: Date.now(), quality: "live", proxy: false, url, note: "Fallback provider." } };
  }
  async getFunding(assetIds: AssetId[]): Promise<FundingInfo[]> {
    const out: FundingInfo[] = [];
    for (const assetId of assetIds) {
      if (assetId === "XAUUSD") continue;
      const symbol = this.symbol(assetId);
      const url = `${BYBIT}/v5/market/tickers?category=linear&symbol=${symbol}`;
      try {
        const res = await fetchJson<{ result: { list: Record<string, string>[] } }>(url);
        const t = res.result?.list?.[0];
        if (!t) continue;
        const rate = parseFloat(t.fundingRate);
        out.push({ assetId, symbol, fundingRate: rate, nextFundingTime: Number(t.nextFundingTime) || null, markPrice: parseFloat(t.markPrice) || null, indexPrice: parseFloat(t.indexPrice) || null, annualizedPct: rate * 3 * 365 * 100, source: { provider: "bybit", label: `Bybit linear ${symbol}`, fetchedAt: Date.now(), asOf: Date.now(), quality: "live", url, note: "Fallback provider." } });
      } catch {
        /* skip symbol */
      }
    }
    if (!out.length) throw new ProviderError(this.id, "no funding");
    return out;
  }
  async getOpenInterest(assetId: AssetId): Promise<OpenInterestInfo> {
    const symbol = this.symbol(assetId);
    const url = `${BYBIT}/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=48`;
    const res = await fetchJson<{ result: { list: { openInterest: string; timestamp: string }[] } }>(url);
    const list = (res.result?.list ?? []).map((x) => ({ time: Number(x.timestamp), oiBase: parseFloat(x.openInterest) })).sort((a, b) => a.time - b.time);
    if (!list.length) throw new ProviderError(this.id, "no OI");
    const last = list[list.length - 1];
    const first = list[0];
    return { assetId, symbol, openInterestBase: last.oiBase, openInterestQuote: null, change24hPct: first.oiBase ? ((last.oiBase - first.oiBase) / first.oiBase) * 100 : null, history: list.map((x) => ({ time: x.time, oiQuote: x.oiBase })), longShortRatio: null, source: { provider: "bybit", label: `Bybit linear ${symbol} open interest (contracts)`, fetchedAt: Date.now(), asOf: last.time, quality: "live", url, note: "Fallback provider; history expressed in contracts, not USD." } };
  }
}

const CB = "https://api.exchange.coinbase.com";
const CB_GRAN: Partial<Record<Timeframe, number>> = { "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 };

export class CoinbaseProvider implements CandleProvider, QuoteProvider {
  readonly id = "coinbase";
  supports(assetId: AssetId): boolean {
    return assetId !== "XAUUSD" && assetId !== "BNBUSD";
  }
  async getCandles(assetId: AssetId, timeframe: Timeframe, limit: number): Promise<CandleResult> {
    const gran = CB_GRAN[timeframe];
    if (!gran) throw new ProviderError(this.id, `timeframe ${timeframe} not supported natively`);
    const product = `${assetBase(assetId)}-USD`;
    const url = `${CB}/products/${product}/candles?granularity=${gran}`;
    const raw = await fetchJson<number[][]>(url);
    const candles: Candle[] = raw.map((k) => ({ time: k[0] * 1000, open: k[3], high: k[2], low: k[1], close: k[4], volume: k[5] })).sort((a, b) => a.time - b.time).slice(-limit);
    return { candles, source: { provider: "coinbase", label: `Coinbase Exchange ${product}`, fetchedAt: Date.now(), asOf: candles.length ? candles[candles.length - 1].time : Date.now(), quality: "live", url, note: "Fallback provider; Coinbase returns at most 300 candles per request." } };
  }
  async getQuote(assetId: AssetId): Promise<Quote> {
    const product = `${assetBase(assetId)}-USD`;
    const [ticker, stats] = await Promise.all([fetchJson<{ price: string; time: string; volume: string }>(`${CB}/products/${product}/ticker`), fetchJson<{ open: string; high: string; low: string; volume: string }>(`${CB}/products/${product}/stats`)]);
    const price = parseFloat(ticker.price);
    const open = parseFloat(stats.open);
    return { assetId, price, change24h: price - open, changePct24h: open ? ((price - open) / open) * 100 : 0, high24h: parseFloat(stats.high), low24h: parseFloat(stats.low), volume24hBase: parseFloat(stats.volume), source: { provider: "coinbase", label: `Coinbase Exchange ${product}`, fetchedAt: Date.now(), asOf: Date.parse(ticker.time) || Date.now(), quality: "live", note: "Fallback provider." } };
  }
}

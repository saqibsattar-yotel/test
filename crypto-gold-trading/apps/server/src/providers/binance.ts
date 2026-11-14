/**
 * Binance public market data (keyless). Spot: klines, 24h tickers, exchangeInfo.
 * USDⓈ-M futures: premiumIndex (funding/mark), openInterest, openInterestHist, long/short.
 */
import type { AssetId, Candle, DataSource, Quote, Timeframe } from "@terminal/core";
import { assetBase, isMetalAsset } from "@terminal/core";
import { fetchJson } from "../lib/http";
import type { CandleProvider, CandleResult, DerivativesProvider, FundingInfo, OpenInterestInfo, QuoteProvider } from "./types";
import { ProviderError } from "./types";

const SPOT = "https://api.binance.com";
const FAPI = "https://fapi.binance.com";

export function binanceSymbol(assetId: AssetId): string | null {
  if (isMetalAsset(assetId)) return null; // spot gold and silver are served by the metals service, never by a token
  const base = assetBase(assetId);
  return base ? `${base}USDT` : null;
}

/** Inverse mapping for stream symbols; PAXGUSDT serves both the gold proxy and PAXG itself. */
export function assetIdsForBinanceSymbol(symbol: string): AssetId[] {
  if (!symbol.endsWith("USDT")) return [];
  const base = symbol.slice(0, -4);
  return [`${base}USD`];
}

const INTERVALS: Record<Timeframe, string> = { "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w" };

type RawKline = [number, string, string, string, string, string, number, string, number, string, string, string];

export function parseKlines(raw: RawKline[]): Candle[] {
  return raw.map((k) => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
}

function src(label: string, asOf: number, proxy = false, note?: string, url?: string): DataSource {
  return { provider: "binance", label, fetchedAt: Date.now(), asOf, quality: proxy ? "proxy" : "live", proxy, note, url };
}

export class BinanceSpotProvider implements CandleProvider, QuoteProvider {
  readonly id = "binance";
  supports(assetId: AssetId): boolean {
    return binanceSymbol(assetId) !== null;
  }
  async getCandles(assetId: AssetId, timeframe: Timeframe, limit: number): Promise<CandleResult> {
    const symbol = binanceSymbol(assetId);
    if (!symbol) throw new ProviderError(this.id, `unsupported asset ${assetId}`);
    const url = `${SPOT}/api/v3/klines?symbol=${symbol}&interval=${INTERVALS[timeframe]}&limit=${Math.min(1000, limit)}`;
    const raw = await fetchJson<RawKline[]>(url);
    if (!Array.isArray(raw)) throw new ProviderError(this.id, "unexpected klines payload");
    const candles = parseKlines(raw);
    // Drop the in-progress bar's inconsistency? Keep it — the UI shows the live bar; the
    // analysis engines use closes and the quality check tracks staleness.
    const lastClose = candles.length ? candles[candles.length - 1].time : Date.now();
    return { candles, source: src(symbol === "PAXGUSDT" ? "Binance spot PAXG/USDT (tokenised gold, crypto venue)" : `Binance spot ${symbol}`, lastClose, false, symbol === "PAXGUSDT" ? "PAX Gold is a token backed by vaulted gold; it trades 24/7 on a crypto venue and is NOT spot XAU/USD." : "USDT quote treated as USD.", url) };
  }
  /** Historical page ending at `endTime` (exclusive), oldest -> newest. */
  async getCandlesBefore(assetId: AssetId, timeframe: Timeframe, endTime: number, limit = 1000): Promise<Candle[]> {
    const symbol = binanceSymbol(assetId);
    if (!symbol) throw new ProviderError(this.id, `unsupported asset ${assetId}`);
    const raw = await fetchJson<RawKline[]>(`${SPOT}/api/v3/klines?symbol=${symbol}&interval=${INTERVALS[timeframe]}&endTime=${endTime - 1}&limit=${Math.min(1000, limit)}`);
    return parseKlines(raw);
  }
  async getQuote(assetId: AssetId): Promise<Quote> {
    const symbol = binanceSymbol(assetId);
    if (!symbol) throw new ProviderError(this.id, `unsupported asset ${assetId}`);
    const url = `${SPOT}/api/v3/ticker/24hr?symbol=${symbol}`;
    const t = await fetchJson<Record<string, string | number>>(url);
    const price = parseFloat(String(t.lastPrice));
    if (!Number.isFinite(price)) throw new ProviderError(this.id, "ticker missing lastPrice");
    return {
      assetId,
      price,
      change24h: parseFloat(String(t.priceChange)),
      changePct24h: parseFloat(String(t.priceChangePercent)),
      high24h: parseFloat(String(t.highPrice)),
      low24h: parseFloat(String(t.lowPrice)),
      volume24hBase: parseFloat(String(t.volume)),
      volume24hQuote: parseFloat(String(t.quoteVolume)),
      source: src(`Binance spot ${symbol} 24h ticker`, Number(t.closeTime) || Date.now(), false, symbol === "PAXGUSDT" ? "Tokenised gold (PAXG), not spot XAU/USD." : undefined, url),
    };
  }
  async getQuotes(assetIds: AssetId[]): Promise<Quote[]> {
    const symbols = assetIds.map(binanceSymbol).filter((s): s is string => !!s);
    const url = `${SPOT}/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
    const list = await fetchJson<Record<string, string | number>[]>(url);
    const bySymbol = new Map(list.map((t) => [String(t.symbol), t]));
    return assetIds.flatMap((assetId) => {
      const t = bySymbol.get(binanceSymbol(assetId)!);
      if (!t) return [];
      return [
        {
          assetId,
          price: parseFloat(String(t.lastPrice)),
          change24h: parseFloat(String(t.priceChange)),
          changePct24h: parseFloat(String(t.priceChangePercent)),
          high24h: parseFloat(String(t.highPrice)),
          low24h: parseFloat(String(t.lowPrice)),
          volume24hBase: parseFloat(String(t.volume)),
          volume24hQuote: parseFloat(String(t.quoteVolume)),
          source: src(`Binance spot ${String(t.symbol)} 24h ticker`, Number(t.closeTime) || Date.now(), false, String(t.symbol) === "PAXGUSDT" ? "Tokenised gold (PAXG), not spot XAU/USD." : undefined, url),
        } satisfies Quote,
      ];
    });
  }
  async getExchangeFilters(assetId: AssetId): Promise<{ tickSize: number; stepSize: number; minQty: number; minNotional: number } | null> {
    const symbol = binanceSymbol(assetId);
    if (!symbol) return null;
    const info = await fetchJson<{ symbols: { symbol: string; filters: { filterType: string; tickSize?: string; stepSize?: string; minQty?: string; minNotional?: string }[] }[] }>(`${SPOT}/api/v3/exchangeInfo?symbol=${symbol}`);
    const s = info.symbols?.[0];
    if (!s) return null;
    const f = (type: string) => s.filters.find((x) => x.filterType === type);
    return { tickSize: parseFloat(f("PRICE_FILTER")?.tickSize ?? "0.01"), stepSize: parseFloat(f("LOT_SIZE")?.stepSize ?? "0.00001"), minQty: parseFloat(f("LOT_SIZE")?.minQty ?? "0.00001"), minNotional: parseFloat(f("NOTIONAL")?.minNotional ?? f("MIN_NOTIONAL")?.minNotional ?? "5") };
  }
}

export class BinanceFuturesProvider implements DerivativesProvider {
  readonly id = "binance-futures";
  async getFunding(assetIds: AssetId[]): Promise<FundingInfo[]> {
    const url = `${FAPI}/fapi/v1/premiumIndex`;
    const all = await fetchJson<Record<string, string | number>[]>(url);
    const bySymbol = new Map(all.map((p) => [String(p.symbol), p]));
    const out: FundingInfo[] = [];
    for (const assetId of assetIds) {
      if (isMetalAsset(assetId)) continue;
      const symbol = binanceSymbol(assetId)!;
      const p = bySymbol.get(symbol);
      if (!p) continue;
      const rate = parseFloat(String(p.lastFundingRate));
      if (!Number.isFinite(rate)) continue;
      out.push({
        assetId,
        symbol,
        fundingRate: rate,
        nextFundingTime: Number(p.nextFundingTime) || null,
        markPrice: parseFloat(String(p.markPrice)) || null,
        indexPrice: parseFloat(String(p.indexPrice)) || null,
        annualizedPct: rate * 3 * 365 * 100,
        source: { provider: "binance-futures", label: `Binance USDⓈ-M ${symbol} premium index`, fetchedAt: Date.now(), asOf: Number(p.time) || Date.now(), quality: "live", note: "lastFundingRate is the most recent 8h settlement rate.", url },
      });
    }
    if (out.length === 0) throw new ProviderError(this.id, "no funding data for requested assets");
    return out;
  }
  async getOpenInterest(assetId: AssetId): Promise<OpenInterestInfo> {
    if (isMetalAsset(assetId)) throw new ProviderError(this.id, `no perpetual for ${assetBase(assetId)}`);
    const symbol = binanceSymbol(assetId)!;
    const [oi, hist, ls] = await Promise.all([
      fetchJson<{ openInterest: string; time: number }>(`${FAPI}/fapi/v1/openInterest?symbol=${symbol}`),
      fetchJson<{ timestamp: number; sumOpenInterest: string; sumOpenInterestValue: string }[]>(`${FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=48`).catch(() => [] as { timestamp: number; sumOpenInterest: string; sumOpenInterestValue: string }[]),
      fetchJson<{ longShortRatio: string }[]>(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`).catch(() => [] as { longShortRatio: string }[]),
    ]);
    const history = hist.map((h) => ({ time: h.timestamp, oiQuote: parseFloat(h.sumOpenInterestValue) }));
    const first = history[0]?.oiQuote;
    const lastQ = history[history.length - 1]?.oiQuote;
    const change = first && lastQ ? ((lastQ - first) / first) * 100 : null;
    return {
      assetId,
      symbol,
      openInterestBase: parseFloat(oi.openInterest),
      openInterestQuote: lastQ ?? null,
      change24hPct: change,
      history,
      longShortRatio: ls[0] ? parseFloat(ls[0].longShortRatio) : null,
      source: { provider: "binance-futures", label: `Binance USDⓈ-M ${symbol} open interest`, fetchedAt: Date.now(), asOf: oi.time, quality: "live", note: "Open-interest history is hourly over the last 48h; 24h change compares the first and last points." },
    };
  }
}

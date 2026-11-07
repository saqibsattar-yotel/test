import type { AssetId, Candle, DataSource, Quote, Timeframe } from "@terminal/core";

export interface CandleResult {
  candles: Candle[];
  source: DataSource;
}

export interface CandleProvider {
  readonly id: string;
  supports(assetId: AssetId): boolean;
  getCandles(assetId: AssetId, timeframe: Timeframe, limit: number): Promise<CandleResult>;
}

export interface QuoteProvider {
  readonly id: string;
  supports(assetId: AssetId): boolean;
  getQuote(assetId: AssetId): Promise<Quote>;
}

export interface FundingInfo {
  assetId: AssetId;
  symbol: string;
  fundingRate: number; // latest 8h rate (decimal)
  nextFundingTime: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  annualizedPct: number;
  source: DataSource;
}

export interface OpenInterestInfo {
  assetId: AssetId;
  symbol: string;
  openInterestBase: number;
  openInterestQuote: number | null;
  change24hPct: number | null;
  history: { time: number; oiQuote: number }[];
  longShortRatio: number | null;
  source: DataSource;
}

export interface DerivativesProvider {
  readonly id: string;
  getFunding(assetIds: AssetId[]): Promise<FundingInfo[]>;
  getOpenInterest(assetId: AssetId): Promise<OpenInterestInfo>;
}

export class ProviderError extends Error {
  constructor(public readonly provider: string, message: string, public readonly cause?: unknown) {
    super(`${provider}: ${message}`);
  }
}

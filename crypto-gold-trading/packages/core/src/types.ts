/**
 * Shared domain types for the Crypto & Gold Trading Intelligence Terminal.
 *
 * Every piece of market data carries provenance (`DataSource`) so the UI can always
 * show where a number came from, when it was fetched, and whether it is a proxy,
 * stale, or explicit demo data. Nothing in this package fabricates prices.
 */

export type Timeframe = "5m" | "15m" | "1h" | "4h" | "1d" | "1w";

export const TIMEFRAMES: Timeframe[] = ["5m", "15m", "1h", "4h", "1d", "1w"];

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

export type AssetClass = "crypto" | "gold" | "silver";

/**
 * Asset identifiers are canonical `<BASE>USD` strings (BTCUSD, POLUSD, ENAUSD, XAUUSD, XAGUSD).
 * A curated core set carries hand-tuned metadata below; any other id is resolved on the fly
 * with `resolveAsset`, and the server validates ids against the live exchange universe.
 */
export type AssetId = string;

export interface AssetMeta {
  id: AssetId;
  symbol: string; // display symbol e.g. "BTC/USD"
  name: string;
  assetClass: AssetClass;
  base: string; // BTC, XAU, XAG
  quote: string; // USD
  pricePrecision: number; // decimals for display
  /** Approximate typical "round number" step for psychological levels. */
  roundStep: number;
  /** True when the instrument trades continuously (crypto) vs. with session closes (gold, silver). */
  continuous: boolean;
}

export const ASSETS: Record<string, AssetMeta> = {
  BTCUSD: { id: "BTCUSD", symbol: "BTC/USD", name: "Bitcoin", assetClass: "crypto", base: "BTC", quote: "USD", pricePrecision: 1, roundStep: 1000, continuous: true },
  ETHUSD: { id: "ETHUSD", symbol: "ETH/USD", name: "Ethereum", assetClass: "crypto", base: "ETH", quote: "USD", pricePrecision: 2, roundStep: 100, continuous: true },
  SOLUSD: { id: "SOLUSD", symbol: "SOL/USD", name: "Solana", assetClass: "crypto", base: "SOL", quote: "USD", pricePrecision: 2, roundStep: 10, continuous: true },
  BNBUSD: { id: "BNBUSD", symbol: "BNB/USD", name: "BNB", assetClass: "crypto", base: "BNB", quote: "USD", pricePrecision: 2, roundStep: 50, continuous: true },
  XRPUSD: { id: "XRPUSD", symbol: "XRP/USD", name: "XRP", assetClass: "crypto", base: "XRP", quote: "USD", pricePrecision: 4, roundStep: 0.1, continuous: true },
  ADAUSD: { id: "ADAUSD", symbol: "ADA/USD", name: "Cardano", assetClass: "crypto", base: "ADA", quote: "USD", pricePrecision: 4, roundStep: 0.05, continuous: true },
  DOGEUSD: { id: "DOGEUSD", symbol: "DOGE/USD", name: "Dogecoin", assetClass: "crypto", base: "DOGE", quote: "USD", pricePrecision: 5, roundStep: 0.01, continuous: true },
  AVAXUSD: { id: "AVAXUSD", symbol: "AVAX/USD", name: "Avalanche", assetClass: "crypto", base: "AVAX", quote: "USD", pricePrecision: 2, roundStep: 5, continuous: true },
  LINKUSD: { id: "LINKUSD", symbol: "LINK/USD", name: "Chainlink", assetClass: "crypto", base: "LINK", quote: "USD", pricePrecision: 3, roundStep: 1, continuous: true },
  XAUUSD: { id: "XAUUSD", symbol: "XAU/USD", name: "Gold (spot)", assetClass: "gold", base: "XAU", quote: "USD", pricePrecision: 2, roundStep: 50, continuous: false },
  XAGUSD: { id: "XAGUSD", symbol: "XAG/USD", name: "Silver (spot)", assetClass: "silver", base: "XAG", quote: "USD", pricePrecision: 3, roundStep: 1, continuous: false },
};

export const CRYPTO_ASSETS: AssetId[] = ["BTCUSD", "ETHUSD", "SOLUSD", "BNBUSD", "XRPUSD", "ADAUSD", "DOGEUSD", "AVAXUSD", "LINKUSD"];

/**
 * Spot precious metals. They are OTC markets with sessions and a weekend close, served by the metals
 * data service (bank quotes and an archive), never by a crypto exchange or a tokenised stand-in.
 */
export type Metal = "gold" | "silver";
export type MetalId = "XAUUSD" | "XAGUSD";

export interface MetalInfo {
  id: MetalId;
  /** Also the asset class, the URL segment (/gold, /silver) and the key in API payloads. */
  metal: Metal;
  /** "Gold" / "Silver", for the start of a sentence or a title. */
  title: string;
  /** ISO 4217 code: XAU, XAG. */
  code: string;
  /** "XAU/USD": the pair as quoted, also the instrument name on the quote feed. */
  pair: string;
  /** Troy ounces in one standard lot at most retail brokers, and in one COMEX contract. */
  standardLotOz: number;
}

export const METALS: Record<MetalId, MetalInfo> = {
  XAUUSD: { id: "XAUUSD", metal: "gold", title: "Gold", code: "XAU", pair: "XAU/USD", standardLotOz: 100 },
  XAGUSD: { id: "XAGUSD", metal: "silver", title: "Silver", code: "XAG", pair: "XAG/USD", standardLotOz: 5000 },
};

/** Gold first: it is loaded and listed first wherever both metals appear. */
export const METAL_ASSETS: MetalId[] = ["XAUUSD", "XAGUSD"];

export function isMetalAsset(id: string): id is MetalId {
  return id === "XAUUSD" || id === "XAGUSD";
}

export function isMetalClass(assetClass: string | null | undefined): assetClass is Metal {
  return assetClass === "gold" || assetClass === "silver";
}

/** The spot instrument of a metal: gold -> XAUUSD, silver -> XAGUSD. */
export function metalAssetId(metal: Metal): MetalId {
  return metal === "silver" ? "XAGUSD" : "XAUUSD";
}

export function metalInfo(metal: Metal | MetalId): MetalInfo {
  return METALS[metal === "gold" || metal === "silver" ? metalAssetId(metal) : metal];
}

const ASSET_ID_RE = /^[A-Z0-9]{2,15}USD$/;

/** True for a syntactically valid canonical id (core or otherwise). Live support is checked server-side. */
export function isAssetId(value: string): value is AssetId {
  return typeof value === "string" && ASSET_ID_RE.test(value);
}

export function isCoreAsset(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(ASSETS, id);
}

/** Base ticker for an id: BTCUSD -> BTC, XAUUSD -> XAU, XAGUSD -> XAG. */
export function assetBase(id: string): string {
  return id.replace(/USD$/, "");
}

/** Display decimals appropriate for a price magnitude. */
export function precisionForPrice(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 4;
  if (price >= 1000) return 1;
  if (price >= 100) return 2;
  if (price >= 10) return 3;
  if (price >= 1) return 4;
  if (price >= 0.1) return 5;
  if (price >= 0.01) return 6;
  return 8;
}

/** Psychological round-number step for a price magnitude (BTC 76,000 -> 1,000; SOL 89 -> 10; XRP 2.3 -> 0.1). */
export function roundStepForPrice(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 1;
  return Math.pow(10, Math.floor(Math.log10(price / 8)));
}

/**
 * Metadata for any asset id. Core assets return their curated entry; everything else is
 * derived (crypto, continuous, precision/round step from the price hint when given).
 */
export function resolveAsset(id: string, hint: { price?: number; name?: string; pricePrecision?: number } = {}): AssetMeta {
  const core = ASSETS[id];
  if (core) return core;
  const base = assetBase(id) || id;
  return {
    id,
    symbol: `${base}/USD`,
    name: hint.name ?? base,
    assetClass: "crypto",
    base,
    quote: "USD",
    pricePrecision: hint.pricePrecision ?? precisionForPrice(hint.price ?? NaN),
    roundStep: roundStepForPrice(hint.price ?? NaN),
    continuous: true,
  };
}

/** A single OHLCV bar. `time` is the bar OPEN time in epoch milliseconds (UTC). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type DataQuality = "live" | "delayed" | "stale" | "proxy" | "demo" | "unavailable" | "closed";

/** Provenance attached to every market-data payload. */
export interface DataSource {
  provider: string; // e.g. "binance", "coingecko", "twelvedata", "demo"
  /** Human-readable description for the UI, e.g. "Binance spot (BTCUSDT)". */
  label: string;
  /** When the server fetched this payload (epoch ms). */
  fetchedAt: number;
  /** The timestamp the data itself refers to (last bar close / quote time), epoch ms. */
  asOf: number;
  quality: DataQuality;
  /** True if this is a stand-in instrument (e.g. PAXG for XAU) — the UI must say so. */
  proxy?: boolean;
  /** True if part of the history could not be loaded yet: the series has gaps and must not drive decisions. */
  incomplete?: boolean;
  /** Explicit, honest note about limitations ("ECB reference rates, daily, 16:00 CET"). */
  note?: string;
  url?: string;
}

export interface Quote {
  assetId: AssetId;
  price: number;
  /**
   * Change against the reference price: 24 hours ago for crypto, the previous close for spot metals.
   * Null when that reference price is not known (never a made-up zero).
   */
  change24h: number | null; // absolute
  changePct24h: number | null; // percent
  high24h?: number;
  low24h?: number;
  volume24hBase?: number;
  volume24hQuote?: number;
  source: DataSource;
}

export interface Series<T = number> {
  values: T[];
  source: DataSource;
}

/** Price level with provenance. */
export type LevelKind =
  | "swing_high"
  | "swing_low"
  | "resistance"
  | "support"
  | "ema"
  | "vwap"
  | "bollinger"
  | "fib_retracement"
  | "fib_extension"
  | "round_number"
  | "prev_day_high"
  | "prev_day_low"
  | "prev_week_high"
  | "prev_week_low"
  | "session_high"
  | "session_low"
  | "liquidity"
  | "atr_projection";

export interface Level {
  price: number;
  kind: LevelKind;
  label: string;
  /** 0..1 — how much weight the engine gives this level (touches, recency, confluence). */
  strength: number;
  timeframe?: Timeframe;
  touches?: number;
  /** Epoch ms of the last touch / creation. */
  lastTouched?: number;
}

export type Bias = "bullish" | "bearish" | "neutral";
export type Direction = "LONG" | "SHORT";

export type SetupStatus =
  | "STRONG LONG"
  | "LONG"
  | "WAIT FOR CONFIRMATION"
  | "NEUTRAL"
  | "SHORT"
  | "STRONG SHORT"
  | "NO TRADE";

export type SetupType =
  | "trend_pullback"
  | "breakout"
  | "breakdown"
  | "range_fade"
  | "mean_reversion"
  | "liquidity_sweep_reversal";

export interface Target {
  label: "TP1" | "TP2" | "TP3";
  price: number;
  /** Why this level: the structural basis the engine used. */
  basis: string;
  rMultiple: number;
}

export interface EvidenceItem {
  text: string;
  weight: number; // signed contribution to the quality score
  category: "trend" | "structure" | "momentum" | "volume" | "volatility" | "regime" | "levels" | "risk" | "data";
}

/** One indicator's reading and its signed contribution to the setup (positive = supports the direction). */
export interface IndicatorContribution {
  indicator: string;
  timeframe: Timeframe;
  value: string;
  read: Bias;
  weight: number;
  note?: string;
}

export interface MtfConfirmation {
  timeframe: Timeframe;
  bias: Bias;
  strength: number;
  /** true = agrees with the setup direction, false = opposes, null = neutral. */
  agrees: boolean | null;
  note: string;
}

export interface KeyLevelEntry {
  price: number;
  label: string;
  strength: number;
  kind: LevelKind;
}

export interface KeyLevels {
  support: KeyLevelEntry[];
  resistance: KeyLevelEntry[];
  liquidityAbove: KeyLevelEntry[];
  liquidityBelow: KeyLevelEntry[];
  structure: { trend: string; description: string; lastSwingHigh: number | null; lastSwingLow: number | null; breakout: string | null };
}

export interface EvidenceSufficiency {
  sufficient: boolean;
  supportingWeight: number;
  opposingWeight: number;
  supportingCount: number;
  categoriesCovered: string[];
  reasons: string[];
}

export interface DataStatusEntry {
  timeframe: Timeframe;
  asOf: number;
  bars: number;
  stale: boolean;
  ok: boolean;
  issues: string[];
}

export interface TradeSetup {
  id: string;
  assetId: AssetId;
  symbol: string;
  direction: Direction | null;
  status: SetupStatus;
  setupType: SetupType | null;
  timeframe: Timeframe;
  /** Higher timeframe used to establish the trend context. */
  contextTimeframe: Timeframe;
  currentPrice: number;
  entry: { low: number; high: number; mid: number; mode: "immediate" | "limit_zone" | "confirmation" };
  stopLoss: number | null;
  targets: Target[];
  riskRewardTp1: number | null;
  riskRewardTp2: number | null;
  qualityScore: number; // 0..100 methodology-based, NOT a win probability
  confidence: "low" | "medium" | "high";
  expectedHold: string;
  regime: string;
  /** Precise statement of the price condition that invalidates the thesis. */
  invalidation: string;
  /** Setup expires after this epoch ms if no entry is triggered. */
  expiresAt: number;
  /** Pre-conditions that must be true before entering (empty for immediate entries). */
  entryConditions: string[];
  supporting: EvidenceItem[];
  opposing: EvidenceItem[];
  rationale: string[]; // deterministic, rule-based explanation lines
  dataAsOf: number;
  dataSource: DataSource;
  assumptions: string[];
  /** Which indicators contributed, with signed weights (transparency). */
  contributions?: IndicatorContribution[];
  /** Per-timeframe agreement with the setup direction. */
  mtfConfirmation?: MtfConfirmation[];
  mtfConfirmed?: boolean;
  keyLevels?: KeyLevels | null;
  sufficiency?: EvidenceSufficiency;
  dataStatus?: DataStatusEntry[];
  entryBasis?: string;
  stopBasis?: string;
  /** Suggested sizing at a default risk % for display (purely informational). */
  sizingPreview?: {
    accountBalance: number;
    riskPct: number;
    quantity: number;
    quantityUnit: string;
    riskAmount: number;
    potentialProfitTp2: number;
  };
  generatedAt: number;
}

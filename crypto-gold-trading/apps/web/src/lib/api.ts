import type { AssetId, Candle, DataSource, EconEvent, JournalTrade, Level, PerformanceStats, Quote, SizingResult, InstrumentSpec, Timeframe, TradeSetup, MtfResult, CryptoRegimeResult, MetalRegimeResult, Metal, GateResult, CircuitBreakerDecision, IndicatorSnapshot, StructureSummary, SRLevel, PeriodLevels, SessionRange, QualityReport, AssetMeta, ComponentResult, MonitoredSetup, BacktestResult } from "@terminal/core";

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

/**
 * The server answers "202 Accepted" with `warming: true` while data is being downloaded for the first
 * time on this machine. That is "not ready yet", not a failure: queries keep their loading state and
 * ask again.
 */
export function isWarmingError(error: unknown): boolean {
  return error instanceof ApiError && (error.body as { warming?: unknown } | null | undefined)?.warming === true;
}

/**
 * "202 Accepted" with `unavailable: true`: the source is known to be out (for example a metal's price
 * history that the archive has not delivered) while the server keeps trying. Unlike "warming" this is
 * shown as an error state with its reason, not as loading; it clears by itself.
 */
export function isUnavailableError(error: unknown): boolean {
  return error instanceof ApiError && (error.body as { unavailable?: unknown } | null | undefined)?.unavailable === true;
}

/** Archive files of one kind: how many were needed, how many are in, how many are waiting to be retried. */
export interface ArchiveClassProgress {
  total: number;
  done: number;
  failing: number;
}

/** Progress of the one-time history download (GET /api/status/warmup). `warming` covers the gold and silver history only. */
export interface WarmupStatus {
  warming: boolean;
  /** Nothing at all had been downloaded before this start. */
  firstRun: boolean;
  /** Metals whose history had never been downloaded on this machine when the server started. */
  firstTime: Metal[];
  startedAt: number | null;
  finishedAt: number | null;
  steps: { id: string; metal: Metal; label: string; state: "pending" | "running" | "done" | "failed"; ms: number | null; error?: string }[];
  /** Some history of this metal is being served with gaps because the archive kept refusing files. */
  goldGaps: boolean;
  silverGaps: boolean;
  /** Metals of which the archive has delivered nothing at all: their charts and analysis say "unavailable" (live prices still work). */
  unavailable: Metal[];
  /** The close-based dollar-index history downloads after the metals, in the background. */
  dollarIndex: "pending" | "downloading" | "ready";
  archive: { gold: ArchiveClassProgress; silver: ArchiveClassProgress; other: ArchiveClassProgress; active: number; queued: number; state: "ok" | "paused" | "recovering"; resumesAt: number | null; nextRetryAt: number | null };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body !== undefined ? { "content-type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error ?? `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg, data);
  }
  // 202 + `warming` is the server saying "not ready yet": surface it as a (retryable) error, never as data.
  if (res.status === 202 && (data as { warming?: unknown } | null)?.warming === true) throw new ApiError(202, (data as { error?: string }).error ?? "Data is still being prepared", data);
  // 202 + `unavailable`: the source is out for now. Also an error, never data; shown with its reason.
  if (res.status === 202 && (data as { unavailable?: unknown } | null)?.unavailable === true) throw new ApiError(202, (data as { error?: string }).error ?? "This data is not available right now", data);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

// ---- Response shapes (mirror apps/server) ----
export interface FeatureFlags {
  ai: { enabled: boolean; model: string | null; fallback: string };
  goldSpot: { provider: string; proxy: boolean };
  silverSpot: { provider: string; proxy: boolean };
  macro: { yields: string; dollarIndex: string };
  calendar: { officialSchedule: boolean; forexFactoryFeed: boolean };
  demoMode: "auto" | "force" | "off";
}

export interface Narrative {
  text: string;
  paragraphs: string[];
  mode: "llm" | "rule-based";
  model: string | null;
  grounded: boolean;
  ungroundedNumbers: string[];
  generatedAt: number;
  factsAsOf: number | null;
  disclaimer: string;
  warning?: string;
}

export interface GlobalMarket {
  totalMarketCapUsd: number;
  totalVolume24hUsd: number;
  btcDominancePct: number;
  ethDominancePct: number;
  marketCapChange24hPct: number;
  activeCryptocurrencies: number;
  source: DataSource;
}
export interface FearGreed {
  value: number;
  classification: string;
  timestamp: number;
  history: { time: number; value: number }[];
  source: DataSource;
}
export interface FundingItem {
  assetId: AssetId;
  rate: number;
  annualizedPct: number;
  nextFundingTime: number | null;
}
export interface FundingInfo {
  assetId: AssetId;
  symbol: string;
  fundingRate: number;
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
export interface MacroSeries {
  id: string;
  label: string;
  unit: string;
  points: { date: string; value: number }[];
  latest: number;
  change1d: number | null;
  change20d: number | null;
  source: DataSource;
}
export interface MacroResponse {
  dxy: MacroSeries | null;
  dgs10: MacroSeries | null;
  dgs2: MacroSeries | null;
  real10: MacroSeries | null;
  curve: MacroSeries | null;
  errors: string[];
}
export interface NewsItem {
  id: string;
  title: string;
  link: string;
  publishedAt: number;
  publisher: string;
  /** What the feed the item came from is about (a silver headline is one whose `relevance` includes "silver"). */
  topics: ("crypto" | "gold" | "macro")[];
  summary: string | null;
  relevance: string[];
}
export interface LiquidationsSummary {
  connected: boolean;
  since: number;
  coverageMs: number;
  totalLongUsd: number;
  totalShortUsd: number;
  perSymbol: Record<string, { longUsd: number; shortUsd: number; count: number }>;
  timeline: { time: number; longUsd: number; shortUsd: number }[];
  largest: { time: number; symbol: string; side: "LONG" | "SHORT"; price: number; qty: number; usd: number }[];
  recent: { time: number; symbol: string; side: "LONG" | "SHORT"; price: number; qty: number; usd: number }[];
  source: DataSource;
}

export interface OverviewResponse {
  generatedAt: number;
  /** Gold or silver parts are missing because their history is still being downloaded for the first time. */
  warming?: boolean;
  quotes: Quote[];
  global: GlobalMarket | { error: string } | null;
  fearGreed: FearGreed | { error: string } | null;
  funding: { avg8h: number | null; items: FundingItem[]; source: DataSource | null; error?: string } | null;
  regime: { crypto: RegimeSummary | null; gold: RegimeSummary | null; silver: RegimeSummary | null };
  goldTrend: MetalTrend | null;
  silverTrend: MetalTrend | null;
  volatility: { btcAtrPct1d: number | null; goldAtrPct1d: number | null; silverAtrPct1d: number | null; btcBollingerSqueeze: boolean | null };
  conditions: { bullish: string[]; bearish: string[] };
  upcomingEvents: EconEvent[];
  news: NewsItem[];
  briefing: Narrative;
  assetsMeta: AssetMeta[];
}

export interface RegimeSummary {
  score: number | null;
  zone: string;
  guidance: string;
  notes: string[];
}
export interface MetalTrend {
  emaStack: string;
  aboveEma200: boolean;
  rsi: number;
  atrPct: number;
  source: DataSource;
}

export interface TimeframeDetail {
  timeframe: Timeframe;
  indicators: IndicatorSnapshot | null;
  structure: StructureSummary | null;
  support: SRLevel[];
  resistance: SRLevel[];
  quality: QualityReport;
  source: DataSource;
  bars: number;
}
export interface AnalysisResponse {
  assetId: AssetId;
  symbol: string;
  price: number;
  mtf: MtfResult;
  details: TimeframeDetail[];
  periodLevels: PeriodLevels | null;
  sessions: { today: SessionRange[]; previous: SessionRange[] } | null;
  liquidity: Level[];
  volatility: { atrPct4h: number | null; realizedVol30dPct: number | null; atrPct1d: number | null };
  warnings: string[];
  sources: DataSource[];
  asOf: number;
  mtfExplanation: string[];
}

export interface CandlesResponse {
  assetId: AssetId;
  timeframe: Timeframe;
  candles: Candle[];
  source: DataSource;
  warnings: string[];
}

export interface RegimeResponse<T> {
  result: T;
  sources: DataSource[];
  notes: string[];
  explanation: string[];
}
export type CryptoRegimeResponse = RegimeResponse<CryptoRegimeResult>;
/** The posture of gold or silver: the same shape, `result.metal` says which. */
export type MetalRegimeResponse = RegimeResponse<MetalRegimeResult>;

export interface SetupsResponse {
  setups: TradeSetup[];
  errors: Record<string, string>;
  /** Assets whose history is still being downloaded for the first time. */
  warming?: string[];
  timeframe: Timeframe;
  generatedAt: number;
}
export interface SetupDetailResponse {
  primary: TradeSetup;
  alternatives: TradeSetup[];
  levels: Level[];
  mtfSummary: string[];
  sources: DataSource[];
  warnings: string[];
  explanation: string[];
}

export interface CalendarResponse {
  events: EconEvent[];
  sources: { provider: string; label: string; official: boolean; error?: string }[];
  generatedAt: number;
  note: string;
}
export interface NewsResponse {
  items: NewsItem[];
  failed: string[];
  fetchedAt: number;
  feeds: { publisher: string; topics: string[] }[];
}

export interface IntelResponse {
  generatedAt: number;
  warming?: boolean;
  crypto: {
    btcStructure: { price: number; bias: string; alignment: string; summary: string[]; keySupport: number | null; keyResistance: number | null; perTimeframe: { timeframe: Timeframe; bias: string; trend: string; notes: string[] }[]; sources: DataSource[] } | null;
    altStrength: { breadth24hPct: number | null; breadth7dPct: number | null; altsOutperformingBtc24h: string | null; leaders: { symbol: string; change24hPct: number | null; change7dPct: number | null }[]; laggards: { symbol: string; change24hPct: number | null; change7dPct: number | null }[]; source: DataSource | null; why: string };
    dominance: GlobalMarket | { error: string } | null;
    funding: { items: FundingInfo[]; extremes: FundingInfo[]; source: DataSource | null; error?: string; why: string };
    openInterest: { btc: OpenInterestInfo | { error: string } | null; eth: OpenInterestInfo | { error: string } | null; why: string };
    liquidations: LiquidationsSummary & { why: string };
    regime: { score: number | null; zone: string; components: ComponentResult[] } | null;
    news: NewsItem[];
  };
  gold: {
    dollar: MacroSeries | null;
    yields: { tenYear: MacroSeries | null; twoYear: MacroSeries | null; real10y: MacroSeries | null; curve: MacroSeries | null; errors: string[] };
    macroReleases: EconEvent[];
    fed: NewsItem[];
    geopolitics: NewsItem[];
    goldNews: NewsItem[];
    positioning: { available: boolean; note: string };
    posture: { score: number | null; zone: string; components: ComponentResult[]; notes: string[] } | null;
    why: { dollar: string; yields: string; macro: string };
  };
  silver: {
    posture: { score: number | null; zone: string; components: ComponentResult[]; notes: string[] } | null;
    ratio: GoldSilverRatio | null;
    silverNews: NewsItem[];
    positioning: { available: boolean; note: string };
    why: { drivers: string; ratio: string };
  };
}

export interface SizeRequest {
  accountBalance: number;
  accountCurrency: string;
  riskPct: number;
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  takeProfit?: number | null;
  leverage?: number | null;
  specId?: string;
  customSpec?: Partial<InstrumentSpec> & { contractSize: number; kind: InstrumentSpec["kind"] };
  fxQuoteToAccount?: number;
}
export interface SizeResponse {
  result: SizingResult;
  spec: InstrumentSpec;
}
export interface GateRequest {
  entryInWrittenPlan: boolean | null;
  stopPredefined: boolean | null;
  sizeWithinPlan: boolean | null;
  plannedRiskAmount: number | null;
  actualRiskAmount: number | null;
  assetId?: AssetId;
  direction?: "LONG" | "SHORT" | null;
}
export interface GateResponse {
  gate: GateResult;
  circuitBreaker: CircuitBreakerDecision;
}
export interface CircuitResponse {
  circuitBreaker: CircuitBreakerDecision;
  heat: { heatPct: number; status: "ok" | "elevated" | "excessive" };
}

export interface UserSettings {
  timezone: string;
  theme: "dark" | "light" | "system";
  accountBalance: number;
  accountCurrency: string;
  defaultRiskPct: number;
  defaultTimeframe: Timeframe;
  followedAssets: AssetId[];
  followedTimeframes: Timeframe[];
  onboardingComplete: boolean;
  dashboardLayout: string[];
  preferredInstrument: Record<string, string>;
  autoMonitorSetups?: boolean;
}
export interface AlertRule {
  id: string;
  kind: "price_above" | "price_below" | "setup_status" | "regime_change" | "setup_monitor";
  assetId: AssetId | null;
  timeframe?: Timeframe;
  level?: number;
  statuses?: string[];
  note?: string;
  active: boolean;
  createdAt: number;
  lastTriggeredAt: number | null;
  triggerCount: number;
}
export interface TriggeredAlert {
  id: string;
  ruleId: string;
  kind: AlertRule["kind"];
  assetId: AssetId | null;
  message: string;
  value?: number;
  time: number;
  read: boolean;
}
export interface JournalResponse {
  trades: JournalTrade[];
  total: number;
}
export interface StatsResponse {
  stats: PerformanceStats;
  filter: Record<string, unknown>;
  note: string;
}
export interface JournalFilterParams {
  asset?: string;
  class?: string;
  tf?: string;
  setup?: string;
  status?: string;
  from?: string;
  to?: string;
  test?: "1" | "0";
}

export interface MonitorResponse {
  active: MonitoredSetup[];
  history: MonitoredSetup[];
  summary: { active: number; watching: number; entered: number; finished: number; stopped: number; completed: number; expired: number; avgOutcomeR: number | null };
  note: string;
}
export interface BacktestRequest {
  assetId: string;
  timeframe: Timeframe;
  bars: number;
  feesBps: number;
  slippageBps: number;
  riskPct: number;
  startingEquity: number;
  exitModel: "tp1" | "tp2" | "tp3" | "ladder";
  maxPendingBars: number;
  minQuality: number;
  splitPct: number;
  stepBars: number;
  allowLongs: boolean;
  allowShorts: boolean;
}
export interface BacktestResponse {
  result: BacktestResult;
  source: DataSource;
  warnings: string[];
}
/** Cross-check of one metal's spot price (GET /api/market/gold|silver/verification). */
export interface MetalVerification {
  metal: Metal;
  checkedAt: number;
  marketOpen: boolean;
  warming?: boolean;
  spot: { swissquote: { price: number; ts: number } | null; goldApi: { price: number; ts: number } | null; dukascopyLastClose: { price: number; ts: number } | null; twelveData: { price: number; ts: number } | null; maxDeviationPct: number | null; tolerancePct: number; status: "verified" | "divergent" | "insufficient" };
  dxy: { live: { value: number; ts: number } | null; archiveLastClose: { value: number; ts: number } | null; syntheticEcb: { value: number; date: string } | null; maxDeviationPct: number | null; status: "verified" | "divergent" | "insufficient" };
  notes: string[];
}
/** XAU/USD ÷ XAG/USD from the two spot quotes, with its place in the last year of daily closes. */
export interface GoldSilverRatio {
  value: number | null;
  ts: number | null;
  gold: number | null;
  silver: number | null;
  year: { high: number; low: number; percentile: number; change20dPct: number | null; days: number } | null;
  source: DataSource;
}
/** The different instruments that carry a metal's name (GET /api/market/gold|silver/instruments). */
export interface MetalInstruments {
  metal: Metal;
  spot: { quote: Quote; kind: string; tradesWhen: string } | null;
  /** Gold only: PAX Gold. Silver has no liquid tokenised counterpart on the venues read here. */
  tokenized: { quote: Quote; kind: string; premiumVsSpotPct: number | null } | null;
  futures: { kind: string; quote: null; note: string };
  ratio: GoldSilverRatio | null;
  archiveLastDaily: Candle | null;
  sampler: { lastSampleAt: number; lastError: string | null };
  warming?: boolean;
}
export interface SeriesPoint {
  time: number;
  value: number;
}
export interface DxyResponse {
  value: number;
  ts: number;
  quality: DataSource["quality"];
  source: DataSource;
  components: Record<string, number> | null;
  archiveLastClose: SeriesPoint | null;
  computedVsArchivePct: number | null;
  history1h: SeriesPoint[];
  history1d: SeriesPoint[];
  /** The close-based history is still being downloaded in the background; only the live value is available. */
  warming?: boolean;
  /** Download progress of the FX files that history is built from. */
  archive?: ArchiveClassProgress;
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

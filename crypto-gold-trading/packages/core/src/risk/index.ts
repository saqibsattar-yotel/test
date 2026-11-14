/**
 * Risk & position sizing. Deterministic arithmetic only — never an opinion.
 *
 * Methodology adapted from tradermonty/claude-trading-skills `position-sizer` and
 * `futures-position-sizer` (MIT): fixed-fractional risk budget, floor-never-round-up,
 * contract multiplier awareness, tick-grid checks, explicit NO_TRADE when the budget
 * cannot afford one unit, and a static margin disclaimer instead of a fake number.
 */
import { decimalsOf, floorToStep, isFiniteNumber, roundTo } from "../math";
import { isMetalAsset, METALS, type Direction } from "../types";

export type InstrumentKind = "crypto_spot" | "crypto_perp" | "crypto_futures_cme" | "gold_cfd" | "gold_futures" | "silver_cfd" | "silver_futures";

export const INSTRUMENT_KINDS: InstrumentKind[] = ["crypto_spot", "crypto_perp", "crypto_futures_cme", "gold_cfd", "gold_futures", "silver_cfd", "silver_futures"];

/** Broker CFDs on a spot metal: lot size, leverage and margin are the broker's own. */
export function isMetalCfdKind(kind: InstrumentKind): boolean {
  return kind === "gold_cfd" || kind === "silver_cfd";
}

/** Exchange-traded futures: a hard tick grid, and margin set by the exchange and the broker. */
export function isExchangeFuturesKind(kind: InstrumentKind): boolean {
  return kind === "gold_futures" || kind === "silver_futures" || kind === "crypto_futures_cme";
}

/** Whether an instrument kind is a way to trade this asset (gold kinds for XAU/USD, silver kinds for XAG/USD, crypto kinds otherwise). */
export function instrumentKindFitsAsset(kind: InstrumentKind, assetId: string): boolean {
  return isMetalAsset(assetId) ? kind.startsWith(`${METALS[assetId].metal}_`) : kind.startsWith("crypto");
}

export interface InstrumentSpec {
  id: string;
  kind: InstrumentKind;
  label: string;
  /** Base units represented by one unit of `quantity` (1 for spot coins; 100 oz for a standard XAU lot or GC; 5,000 oz for a standard XAG lot or SI). */
  contractSize: number;
  baseUnit: string; // "BTC", "oz"
  quantityUnit: string; // "BTC", "lots", "contracts"
  quoteCurrency: "USD";
  tickSize: number;
  qtyStep: number;
  minQty: number;
  minNotional?: number;
  maxLeverage?: number;
  /** Maintenance margin rate used ONLY for the liquidation estimate (lowest tier). */
  maintenanceMarginRate?: number;
  source: string;
  verified?: string;
  note: string;
  /** Whether `tickSize` is a hard grid (exchange-traded futures) or indicative (CFD/spot). */
  hardTickGrid: boolean;
}

export const INSTRUMENT_SPECS: Record<string, InstrumentSpec> = {
  "binance-spot-BTCUSDT": {
    id: "binance-spot-BTCUSDT",
    kind: "crypto_spot",
    label: "Binance spot BTC/USDT",
    contractSize: 1,
    baseUnit: "BTC",
    quantityUnit: "BTC",
    quoteCurrency: "USD",
    tickSize: 0.01,
    qtyStep: 0.00001,
    minQty: 0.00001,
    minNotional: 5,
    source: "Binance /api/v3/exchangeInfo (filters: PRICE_FILTER, LOT_SIZE, NOTIONAL)",
    note: "Filters change over time; the server refreshes them from exchangeInfo when available. USDT is treated as USD.",
    hardTickGrid: false,
  },
  "binance-perp-BTCUSDT": {
    id: "binance-perp-BTCUSDT",
    kind: "crypto_perp",
    label: "Binance USDⓈ-M perpetual BTC/USDT",
    contractSize: 1,
    baseUnit: "BTC",
    quantityUnit: "BTC",
    quoteCurrency: "USD",
    tickSize: 0.1,
    qtyStep: 0.001,
    minQty: 0.001,
    minNotional: 100,
    maxLeverage: 125,
    maintenanceMarginRate: 0.004,
    source: "Binance Futures /fapi/v1/exchangeInfo + leverage bracket tiers",
    note: "Linear contract (1 contract = 1 BTC notional in USDT). Maintenance margin is tiered by notional; 0.4% is the lowest tier and is used only for the liquidation ESTIMATE.",
    hardTickGrid: false,
  },
  "binance-perp-ETHUSDT": {
    id: "binance-perp-ETHUSDT",
    kind: "crypto_perp",
    label: "Binance USDⓈ-M perpetual ETH/USDT",
    contractSize: 1,
    baseUnit: "ETH",
    quantityUnit: "ETH",
    quoteCurrency: "USD",
    tickSize: 0.01,
    qtyStep: 0.001,
    minQty: 0.001,
    minNotional: 20,
    maxLeverage: 100,
    maintenanceMarginRate: 0.005,
    source: "Binance Futures /fapi/v1/exchangeInfo",
    note: "Linear contract; maintenance margin tiered — lowest tier used for the liquidation estimate.",
    hardTickGrid: false,
  },
  "cme-BTC": {
    id: "cme-BTC",
    kind: "crypto_futures_cme",
    label: "CME Bitcoin futures (BTC)",
    contractSize: 5,
    baseUnit: "BTC",
    quantityUnit: "contracts",
    quoteCurrency: "USD",
    tickSize: 5,
    qtyStep: 1,
    minQty: 1,
    source: "CME Rulebook Chapter 350 (5 bitcoin per contract; $5.00 minimum increment = $25.00)",
    verified: "2026-07-17 (as recorded in tradermonty/claude-trading-skills futures-contract-specs.md)",
    note: "Exchange margin is broker/time-dependent and NOT computed here.",
    hardTickGrid: true,
  },
  "cme-MBT": {
    id: "cme-MBT",
    kind: "crypto_futures_cme",
    label: "CME Micro Bitcoin futures (MBT)",
    contractSize: 0.1,
    baseUnit: "BTC",
    quantityUnit: "contracts",
    quoteCurrency: "USD",
    tickSize: 5,
    qtyStep: 1,
    minQty: 1,
    source: "CME Rulebook Chapter 348 (0.1 bitcoin per contract; $5.00 minimum increment = $0.50)",
    note: "Verify current contract specifications with CME before trading.",
    hardTickGrid: true,
  },
  "xau-cfd-standard": {
    id: "xau-cfd-standard",
    kind: "gold_cfd",
    label: "XAU/USD CFD — standard lot (100 oz)",
    contractSize: 100,
    baseUnit: "oz",
    quantityUnit: "lots",
    quoteCurrency: "USD",
    tickSize: 0.01,
    qtyStep: 0.01,
    minQty: 0.01,
    maxLeverage: 20,
    source: "Common retail broker convention (1 lot = 100 troy oz; $1 move = $100 per lot)",
    note: "BROKER-SPECIFIC. Lot size, minimum lot, leverage and margin differ by broker — verify your own contract specification. Not all brokers use 100 oz lots.",
    hardTickGrid: false,
  },
  "xau-cfd-mini": {
    id: "xau-cfd-mini",
    kind: "gold_cfd",
    label: "XAU/USD CFD — mini lot (10 oz)",
    contractSize: 10,
    baseUnit: "oz",
    quantityUnit: "lots",
    quoteCurrency: "USD",
    tickSize: 0.01,
    qtyStep: 0.01,
    minQty: 0.01,
    maxLeverage: 20,
    source: "Common retail broker convention",
    note: "BROKER-SPECIFIC — verify your contract specification.",
    hardTickGrid: false,
  },
  "comex-GC": {
    id: "comex-GC",
    kind: "gold_futures",
    label: "COMEX Gold futures (GC)",
    contractSize: 100,
    baseUnit: "oz",
    quantityUnit: "contracts",
    quoteCurrency: "USD",
    tickSize: 0.1,
    qtyStep: 1,
    minQty: 1,
    source: "CME Gold futures contract specs (100 troy oz; $0.10 tick = $10.00)",
    verified: "2026-07-17 (as recorded in tradermonty/claude-trading-skills futures-contract-specs.md)",
    note: "Exchange margin is broker/time-dependent and NOT computed here.",
    hardTickGrid: true,
  },
  "comex-MGC": {
    id: "comex-MGC",
    kind: "gold_futures",
    label: "COMEX Micro Gold futures (MGC)",
    contractSize: 10,
    baseUnit: "oz",
    quantityUnit: "contracts",
    quoteCurrency: "USD",
    tickSize: 0.1,
    qtyStep: 1,
    minQty: 1,
    source: "CME Micro Gold futures contract specs (10 troy oz; $0.10 tick = $1.00)",
    note: "Verify current contract specifications with CME before trading.",
    hardTickGrid: true,
  },
  "xag-cfd-standard": {
    id: "xag-cfd-standard",
    kind: "silver_cfd",
    label: "XAG/USD CFD — standard lot (5,000 oz)",
    contractSize: 5000,
    baseUnit: "oz",
    quantityUnit: "lots",
    quoteCurrency: "USD",
    tickSize: 0.001,
    qtyStep: 0.01,
    minQty: 0.01,
    maxLeverage: 10,
    source: "Common retail broker convention (1 lot = 5,000 troy oz; $0.01 move = $50 per lot)",
    note: "BROKER-SPECIFIC. Lot size, minimum lot, leverage and margin differ by broker — verify your own contract specification. Some brokers quote silver in 1,000 oz or 50 oz lots.",
    hardTickGrid: false,
  },
  "xag-cfd-mini": {
    id: "xag-cfd-mini",
    kind: "silver_cfd",
    label: "XAG/USD CFD — mini lot (500 oz)",
    contractSize: 500,
    baseUnit: "oz",
    quantityUnit: "lots",
    quoteCurrency: "USD",
    tickSize: 0.001,
    qtyStep: 0.01,
    minQty: 0.01,
    maxLeverage: 10,
    source: "Common retail broker convention",
    note: "BROKER-SPECIFIC — verify your contract specification.",
    hardTickGrid: false,
  },
  "comex-SI": {
    id: "comex-SI",
    kind: "silver_futures",
    label: "COMEX Silver futures (SI)",
    contractSize: 5000,
    baseUnit: "oz",
    quantityUnit: "contracts",
    quoteCurrency: "USD",
    tickSize: 0.005,
    qtyStep: 1,
    minQty: 1,
    source: "COMEX Rulebook Chapter 112 (5,000 troy oz; $0.005 minimum fluctuation for outright trades = $25.00)",
    verified: "2026-11-14 (COMEX Rulebook Chapter 112 on cmegroup.com)",
    note: "Exchange margin is broker/time-dependent and NOT computed here.",
    hardTickGrid: true,
  },
  "comex-SIL": {
    id: "comex-SIL",
    kind: "silver_futures",
    label: "COMEX Micro Silver futures (SIL)",
    contractSize: 1000,
    baseUnit: "oz",
    quantityUnit: "contracts",
    quoteCurrency: "USD",
    tickSize: 0.005,
    qtyStep: 1,
    minQty: 1,
    source: "CME Micro Silver futures contract specs (1,000 troy oz; $0.005 tick = $5.00)",
    note: "Verify current contract specifications with CME before trading.",
    hardTickGrid: true,
  },
};

export const RISK_PCT_WARNING_THRESHOLD = 2.0;
export const RISK_PCT_MAX = 10.0;
export const CONTRACTS_SANITY_MAX = 1e12;

export interface SizingInput {
  accountBalance: number;
  accountCurrency: string; // display only; conversion via fxQuoteToAccount
  riskPct: number;
  direction: Direction;
  entry: number;
  stop: number;
  takeProfit?: number | null;
  leverage?: number | null;
  spec: InstrumentSpec;
  /** Multiply quote-currency (USD) amounts by this to express them in the account currency. 1 if the account is USD. */
  fxQuoteToAccount?: number;
}

export type SizingStatus = "SIZED" | "NO_TRADE" | "INVALID";

export interface SizingResult {
  status: SizingStatus;
  reasons: string[]; // why INVALID / NO_TRADE
  warnings: string[];
  riskBudgetAccount: number;
  riskBudgetQuote: number;
  stopDistance: number;
  stopDistanceTicks: number | null;
  stopDistancePct: number;
  riskPerUnitQuote: number; // risk of ONE unit of quantity (one lot / contract / coin)
  quantity: number;
  quantityUnit: string;
  baseUnits: number; // e.g. total oz or BTC
  baseUnit: string;
  notionalQuote: number;
  notionalAccount: number;
  marginEstimateAccount: number | null;
  marginNote: string;
  potentialLossAccount: number;
  potentialProfitAccount: number | null;
  riskReward: number | null;
  effectiveRiskPct: number;
  liquidationEstimate: number | null;
  liquidationNote: string | null;
  tickValueQuote: number;
  fxQuoteToAccount: number;
}

function onTickGrid(price: number, tick: number): boolean {
  if (tick <= 0) return true;
  const q = price / tick;
  return Math.abs(q - Math.round(q)) < 1e-6;
}

export function sizePosition(input: SizingInput): SizingResult {
  const { accountBalance, riskPct, direction, entry, stop, spec } = input;
  const fx = input.fxQuoteToAccount && isFiniteNumber(input.fxQuoteToAccount) && input.fxQuoteToAccount > 0 ? input.fxQuoteToAccount : 1;
  const tp = input.takeProfit ?? null;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const tickValue = spec.tickSize * spec.contractSize;
  const base: SizingResult = {
    status: "INVALID",
    reasons,
    warnings,
    riskBudgetAccount: 0,
    riskBudgetQuote: 0,
    stopDistance: 0,
    stopDistanceTicks: null,
    stopDistancePct: 0,
    riskPerUnitQuote: 0,
    quantity: 0,
    quantityUnit: spec.quantityUnit,
    baseUnits: 0,
    baseUnit: spec.baseUnit,
    notionalQuote: 0,
    notionalAccount: 0,
    marginEstimateAccount: null,
    marginNote: isExchangeFuturesKind(spec.kind) ? "Exchange margin requirements are broker- and time-dependent and are NOT computed here. Verify initial/maintenance margin with your broker." : "Margin shown is an ESTIMATE (notional ÷ leverage). Your broker's actual requirement may differ.",
    potentialLossAccount: 0,
    potentialProfitAccount: null,
    riskReward: null,
    effectiveRiskPct: 0,
    liquidationEstimate: null,
    liquidationNote: null,
    tickValueQuote: tickValue,
    fxQuoteToAccount: fx,
  };

  if (!isFiniteNumber(accountBalance) || accountBalance <= 0) reasons.push("Account balance must be a positive number");
  if (!isFiniteNumber(riskPct) || riskPct <= 0 || riskPct > RISK_PCT_MAX) reasons.push(`Risk % must be between 0 and ${RISK_PCT_MAX}`);
  if (!isFiniteNumber(entry) || entry <= 0) reasons.push("Entry price must be a positive number");
  if (!isFiniteNumber(stop) || stop <= 0) reasons.push("Stop-loss price must be a positive number");
  if (reasons.length) return base;
  if (direction === "LONG" && stop >= entry) reasons.push("For a LONG the stop-loss must be below the entry");
  if (direction === "SHORT" && stop <= entry) reasons.push("For a SHORT the stop-loss must be above the entry");
  if (tp !== null) {
    if (!isFiniteNumber(tp) || tp <= 0) reasons.push("Take-profit must be a positive number");
    else if (direction === "LONG" && tp <= entry) reasons.push("For a LONG the take-profit must be above the entry");
    else if (direction === "SHORT" && tp >= entry) reasons.push("For a SHORT the take-profit must be below the entry");
  }
  if (reasons.length) return base;

  const stopDistance = Math.abs(entry - stop);
  if (spec.tickSize > 0 && stopDistance < spec.tickSize - 1e-12) {
    reasons.push(`Stop distance (${stopDistance}) is smaller than one tick (${spec.tickSize})`);
    return base;
  }
  if (spec.hardTickGrid) {
    if (!onTickGrid(entry, spec.tickSize)) reasons.push(`Entry ${entry} is not on the ${spec.tickSize} tick grid for ${spec.label}`);
    if (!onTickGrid(stop, spec.tickSize)) reasons.push(`Stop ${stop} is not on the ${spec.tickSize} tick grid for ${spec.label}`);
    if (reasons.length) return base;
  } else if (spec.tickSize > 0) {
    if (!onTickGrid(entry, spec.tickSize)) warnings.push("Entry is not on the instrument's price increment (fine for a mid-quote, worth a second look)");
  }
  if (riskPct > RISK_PCT_WARNING_THRESHOLD) warnings.push(`Risk ${riskPct}% exceeds the 2% per-trade guideline`);

  const riskBudgetAccount = accountBalance * (riskPct / 100);
  const riskBudgetQuote = riskBudgetAccount / fx;
  const riskPerUnitQuote = stopDistance * spec.contractSize;
  let quantity = floorToStep(riskBudgetQuote / riskPerUnitQuote, spec.qtyStep);
  // Guarantee quantity * riskPerUnit <= budget even with float noise.
  while (quantity > 0 && quantity * riskPerUnitQuote > riskBudgetQuote + 1e-9) quantity = roundTo(quantity - spec.qtyStep, decimalsOf(spec.qtyStep));
  if (quantity > CONTRACTS_SANITY_MAX) {
    reasons.push("Computed quantity is implausibly large — check the inputs");
    return base;
  }
  const result: SizingResult = { ...base, riskBudgetAccount, riskBudgetQuote, stopDistance, stopDistancePct: (stopDistance / entry) * 100, riskPerUnitQuote, stopDistanceTicks: spec.tickSize > 0 ? Math.round(stopDistance / spec.tickSize) : null };

  if (quantity < spec.minQty) {
    result.status = "NO_TRADE";
    result.quantity = 0;
    reasons.push(`Risk budget (${riskBudgetQuote.toFixed(2)} ${spec.quoteCurrency}) cannot afford the minimum quantity (${spec.minQty} ${spec.quantityUnit}) at this stop distance — risk per ${spec.quantityUnit.replace(/s$/, "")} is ${riskPerUnitQuote.toFixed(2)} ${spec.quoteCurrency}. Consider a smaller contract; do not widen or tighten the stop just to fit the budget.`);
    return result;
  }
  const notionalQuote = quantity * spec.contractSize * entry;
  if (spec.minNotional && notionalQuote < spec.minNotional) {
    result.status = "NO_TRADE";
    result.quantity = quantity;
    reasons.push(`Notional ${notionalQuote.toFixed(2)} is below the venue minimum (${spec.minNotional})`);
    return result;
  }
  const potentialLossQuote = quantity * riskPerUnitQuote;
  const potentialProfitQuote = tp !== null ? quantity * spec.contractSize * Math.abs(tp - entry) : null;
  const leverage = input.leverage && isFiniteNumber(input.leverage) && input.leverage > 0 ? input.leverage : null;
  if (leverage && spec.maxLeverage && leverage > spec.maxLeverage) warnings.push(`Leverage ${leverage}x exceeds the instrument's maximum (${spec.maxLeverage}x)`);
  let marginEstimate: number | null = null;
  if (spec.kind === "crypto_perp" || isMetalCfdKind(spec.kind)) {
    marginEstimate = leverage ? notionalQuote / leverage : notionalQuote; // 1x if no leverage given
  } else if (spec.kind === "crypto_spot") {
    marginEstimate = notionalQuote; // fully funded
  }
  let liquidationEstimate: number | null = null;
  let liquidationNote: string | null = null;
  if (spec.kind === "crypto_perp" && leverage) {
    const mmr = spec.maintenanceMarginRate ?? 0.005;
    // Isolated-margin approximation; ignores fees/funding and tiered MMR.
    liquidationEstimate = direction === "LONG" ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr);
    const beyondStop = direction === "LONG" ? liquidationEstimate >= stop : liquidationEstimate <= stop;
    liquidationNote = `Approximate isolated-margin liquidation at ${leverage}x using ${(mmr * 100).toFixed(2)}% maintenance margin; ignores fees, funding and margin tiers. ${beyondStop ? "WARNING: estimated liquidation is at or before your stop — reduce leverage." : "Estimated liquidation sits beyond the stop-loss."}`;
    if (beyondStop) warnings.push("Estimated liquidation price would be hit before the stop-loss at this leverage");
  } else if (spec.kind === "crypto_perp") {
    liquidationNote = "Enter leverage to estimate the liquidation price.";
  }
  if (isMetalCfdKind(spec.kind)) warnings.push("CFD contract size, leverage and margin are broker-specific — verify your broker's specification");
  if (marginEstimate !== null && marginEstimate * fx > accountBalance) warnings.push("Estimated margin exceeds the account balance — position is not fundable at this leverage");

  return {
    ...result,
    status: "SIZED",
    quantity,
    baseUnits: roundTo(quantity * spec.contractSize, 8),
    notionalQuote,
    notionalAccount: notionalQuote * fx,
    marginEstimateAccount: marginEstimate !== null ? marginEstimate * fx : null,
    potentialLossAccount: potentialLossQuote * fx,
    potentialProfitAccount: potentialProfitQuote !== null ? potentialProfitQuote * fx : null,
    riskReward: tp !== null ? Math.abs(tp - entry) / stopDistance : null,
    effectiveRiskPct: (potentialLossQuote * fx * 100) / accountBalance,
    liquidationEstimate,
    liquidationNote,
  };
}

export function riskReward(entry: number, stop: number, target: number): number {
  const risk = Math.abs(entry - stop);
  if (risk === 0) return NaN;
  return Math.abs(target - entry) / risk;
}

/** R-multiple of a closed trade. */
export function rMultiple(direction: Direction, entry: number, stop: number, exit: number): number {
  const risk = Math.abs(entry - stop);
  if (risk === 0) return NaN;
  const move = direction === "LONG" ? exit - entry : entry - exit;
  return move / risk;
}

export function defaultSpecFor(assetId: string, prefer: "spot" | "perp" | "cfd" | "futures" = "spot"): InstrumentSpec {
  if (assetId === "XAUUSD") return prefer === "futures" ? INSTRUMENT_SPECS["comex-GC"] : INSTRUMENT_SPECS["xau-cfd-standard"];
  if (assetId === "XAGUSD") return prefer === "futures" ? INSTRUMENT_SPECS["comex-SI"] : INSTRUMENT_SPECS["xag-cfd-standard"];
  if (prefer === "perp") {
    const base = assetId.replace(/USD$/, "");
    const id = `binance-perp-${base}USDT`;
    if (INSTRUMENT_SPECS[id]) return INSTRUMENT_SPECS[id];
    return { ...INSTRUMENT_SPECS["binance-perp-BTCUSDT"], id, label: `Binance USDⓈ-M perpetual ${base}/USDT`, baseUnit: base, quantityUnit: base, tickSize: 0.0001, qtyStep: 0.001, minNotional: 5 };
  }
  if (prefer === "futures" && assetId === "BTCUSD") return INSTRUMENT_SPECS["cme-BTC"];
  const base = assetId.replace(/USD$/, "");
  const id = `binance-spot-${base}USDT`;
  if (INSTRUMENT_SPECS[id]) return INSTRUMENT_SPECS[id];
  return { ...INSTRUMENT_SPECS["binance-spot-BTCUSDT"], id, label: `Binance spot ${base}/USDT`, baseUnit: base, quantityUnit: base, tickSize: 0.0001, qtyStep: 0.0001, minQty: 0.0001 };
}

/**
 * Base units in one unit of quantity for a journal trade: a metal trade recorded in "lots" uses the
 * standard lot (100 oz of gold, 5,000 oz of silver); everything else is recorded in base units.
 */
export function contractSizeFor(assetId: string, quantityUnit: string): number {
  return isMetalAsset(assetId) && quantityUnit === "lots" ? METALS[assetId].standardLotOz : 1;
}

/** The unit a new trade in this asset is normally recorded in: lots for spot metals, the coin otherwise. */
export function defaultQuantityUnit(assetId: string): string {
  return isMetalAsset(assetId) ? "lots" : assetId.replace(/USD$/, "");
}

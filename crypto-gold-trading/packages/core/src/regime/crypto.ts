/**
 * Crypto Regime Analyzer — TypeScript port of the 6-component methodology from
 * tradermonty/claude-trading-skills (`skills/crypto-regime-analyzer`, MIT License,
 * Copyright (c) 2026 TraderMonty). Thresholds and weights are preserved; see
 * docs/ATTRIBUTION.md. Adaptations: a BTC relative-strength proxy may stand in for
 * dominance *direction* until 31 real daily dominance observations exist, and the
 * result is explicitly labelled when it does.
 *
 * Score direction: 100 = broad risk-on health, 0 = critical risk-off. The score is a
 * descriptive regime heuristic — it is not a probability that any trade will win.
 */
import { mean, stddev } from "../math";
import { sma } from "../indicators";

export interface ComponentResult {
  id: string;
  label: string;
  weight: number;
  score: number; // 0..100 (50 when unavailable)
  signal: string;
  dataAvailable: boolean;
  details: Record<string, number | string | boolean | string[]>;
}

export interface CryptoRegimeInput {
  btcDailyCloses: number[];
  /** Alt universe daily closes (BTC excluded), oldest -> newest. */
  altDailyCloses: Record<string, number[]>;
  /** Real daily BTC dominance observations (percent), oldest -> newest. */
  dominanceSeries: number[];
  /** Fallback: BTC relative-strength ratio vs. an alt basket (direction only). */
  dominanceProxySeries?: number[];
  currentDominance?: number;
  /** Latest 8h funding rate per perp as a decimal (0.0001 = 0.01%). */
  funding: Record<string, number>;
  asOf: number;
}

export type RegimeZone = "RISK_ON" | "NEUTRAL" | "RISK_OFF" | "UNKNOWN";

export interface CryptoRegimeResult {
  score: number | null;
  zone: RegimeZone;
  guidance: string;
  components: ComponentResult[];
  effectiveWeights: Record<string, number>;
  componentsAvailable: number;
  asOf: number;
  methodology: string;
}

export const CRYPTO_COMPONENT_WEIGHTS: Record<string, number> = {
  btc_trend: 0.25,
  alt_breadth: 0.2,
  dominance: 0.15,
  funding: 0.15,
  drawdown_vol: 0.15,
  momentum_thrust: 0.1,
};

const LABELS: Record<string, string> = {
  btc_trend: "BTC Trend Structure",
  alt_breadth: "Alt Breadth Participation",
  dominance: "BTC Dominance Regime",
  funding: "Perpetual Funding Regime",
  drawdown_vol: "Drawdown & Volatility Position",
  momentum_thrust: "Momentum Thrust / Washout",
};

const MIN_AVAILABLE_COMPONENTS = 4;
const MIN_AVAILABLE_WEIGHT = 0.65;

function unavailable(id: string, signal: string): ComponentResult {
  return { id, label: LABELS[id], weight: CRYPTO_COMPONENT_WEIGHTS[id], score: 50, signal, dataAvailable: false, details: {} };
}

function smaLast(values: number[], window: number): number {
  return mean(values.slice(-window));
}

export function btcTrendComponent(closes: number[]): ComponentResult {
  const id = "btc_trend";
  const SLOPE_LOOKBACK = 20;
  if (closes.length < 200 + SLOPE_LOOKBACK) return unavailable(id, `NO DATA: need ≥ ${200 + SLOPE_LOOKBACK} daily closes (have ${closes.length})`);
  const price = closes[closes.length - 1];
  const ma50 = smaLast(closes, 50);
  const ma200 = smaLast(closes, 200);
  const ma200Prev = mean(closes.slice(-(200 + SLOPE_LOOKBACK), -SLOPE_LOOKBACK));
  const rel = Math.abs(ma200 - ma200Prev) / ma200;
  const direction = rel < 1e-12 ? "flat" : ma200 > ma200Prev ? "rising" : "falling";
  let base: number;
  let structure: string;
  const flat = Math.abs(price - ma200) / ma200 < 1e-12 && Math.abs(ma50 - ma200) / ma200 < 1e-12;
  if (flat) {
    base = 50;
    structure = "FLAT (price = 50DMA = 200DMA)";
  } else if (price > ma50 && ma50 > ma200) {
    base = 90;
    structure = "BULL STACK (price > 50DMA > 200DMA)";
  } else if (price > ma200 && price <= ma50 && ma50 > ma200) {
    base = 65;
    structure = "BULL PULLBACK (price between 200DMA and 50DMA)";
  } else if (price <= ma200 && price <= ma50 && ma50 > ma200) {
    base = 55;
    structure = "STACK INTACT, PRICE BELOW (deep pullback / early break)";
  } else if (price > ma50 && ma50 <= ma200) {
    base = 45;
    structure = "RECOVERY ATTEMPT (price above 50DMA, stack still bearish)";
  } else {
    base = 15;
    structure = "BEAR STACK (price < 50DMA < 200DMA)";
  }
  const slopeMod = direction === "rising" ? 10 : direction === "falling" ? -10 : 0;
  const score = Math.max(0, Math.min(100, base + slopeMod));
  let signal = `${structure}; 200DMA ${direction}`;
  if (!flat && Math.abs(ma50 - ma200) / ma200 < 0.015) signal += "; 50/200DMA within 1.5% (cross watch)";
  return { id, label: LABELS[id], weight: CRYPTO_COMPONENT_WEIGHTS[id], score, signal, dataAvailable: true, details: { price, ma50, ma200, ma200Direction: direction } };
}

export function altBreadthComponent(altSeries: Record<string, number[]>): ComponentResult {
  const id = "alt_breadth";
  const eligible = Object.entries(altSeries).filter(([, c]) => c && c.length >= 200);
  const skipped = Object.keys(altSeries).filter((k) => !eligible.some(([s]) => s === k));
  if (eligible.length < 5) return unavailable(id, `NO DATA: only ${eligible.length} alts with ≥ 200d history (need 5)`);
  const pctAbove = (w: number) => (eligible.filter(([, c]) => c[c.length - 1] > smaLast(c, w)).length / eligible.length) * 100;
  const p200 = pctAbove(200);
  const p50 = pctAbove(50);
  let score = p200 >= 80 ? 95 : p200 >= 65 ? 80 : p200 >= 50 ? 65 : p200 >= 35 ? 45 : p200 >= 20 ? 25 : 10;
  let mod = "";
  if (p50 >= p200 + 15) {
    score += 5;
    mod = "; short-term thrust (50DMA breadth leading)";
  } else if (p50 <= p200 - 15) {
    score -= 5;
    mod = "; short-term breadth rolling over";
  }
  score = Math.max(0, Math.min(100, score));
  return {
    id,
    label: LABELS[id],
    weight: CRYPTO_COMPONENT_WEIGHTS[id],
    score,
    signal: `${p200.toFixed(0)}% of ${eligible.length} tracked alts above 200DMA (${p50.toFixed(0)}% above 50DMA)${mod}`,
    dataAvailable: true,
    details: { pctAbove200dma: Math.round(p200 * 10) / 10, pctAbove50dma: Math.round(p50 * 10) / 10, universeSize: eligible.length, skipped },
  };
}

export function dominanceComponent(series: number[], btcTrendUp: boolean, proxySeries?: number[], currentDominance?: number): ComponentResult {
  const id = "dominance";
  const LOOKBACK = 30;
  let direction: "rising" | "falling" | "flat";
  let change: number;
  let usingProxy = false;
  let current = currentDominance ?? NaN;
  if (series.length >= LOOKBACK + 1) {
    current = series[series.length - 1];
    change = current - series[series.length - 1 - LOOKBACK];
    direction = change > 0.5 ? "rising" : change < -0.5 ? "falling" : "flat";
  } else if (proxySeries && proxySeries.length >= LOOKBACK + 1) {
    usingProxy = true;
    const now = proxySeries[proxySeries.length - 1];
    const prev = proxySeries[proxySeries.length - 1 - LOOKBACK];
    change = prev > 0 ? ((now - prev) / prev) * 100 : 0; // percent change of the ratio
    direction = change > 1 ? "rising" : change < -1 ? "falling" : "flat";
  } else {
    return unavailable(id, `NO DATA: need ≥ ${LOOKBACK + 1} daily dominance points (have ${series.length})`);
  }
  let score: number;
  let regime: string;
  if (btcTrendUp) {
    if (direction === "falling") [score, regime] = [90, "ALT ROTATION (BTC up, dominance falling)"];
    else if (direction === "rising") [score, regime] = [65, "BTC-LED (BTC up, dominance rising; alts lagging)"];
    else [score, regime] = [75, "BTC UP, dominance flat"];
  } else {
    if (direction === "rising") [score, regime] = [30, "DEFENSIVE (BTC down, dominance rising)"];
    else if (direction === "falling") [score, regime] = [10, "DE-RISKING (BTC down, dominance falling)"];
    else [score, regime] = [25, "BTC DOWN, dominance flat"];
  }
  let mod = "";
  if (Number.isFinite(current)) {
    if (current >= 62 && !btcTrendUp) {
      score += 5;
      mod = "; dominance at washout extreme (contrarian watch)";
    } else if (current <= 40 && btcTrendUp) {
      score -= 5;
      mod = "; dominance at froth extreme (late-cycle caution)";
    }
  }
  score = Math.max(0, Math.min(100, score));
  const changeText = usingProxy ? `${change >= 0 ? "+" : ""}${change.toFixed(1)}% BTC/alt-basket ratio over ${LOOKBACK}d (PROXY for direction)` : `${change >= 0 ? "+" : ""}${change.toFixed(1)}pts / ${LOOKBACK}d`;
  const domText = Number.isFinite(current) ? `dominance ${current.toFixed(1)}%` : "dominance level unknown";
  return {
    id,
    label: LABELS[id],
    weight: CRYPTO_COMPONENT_WEIGHTS[id],
    score,
    signal: `${regime}; ${domText} (${changeText})${mod}`,
    dataAvailable: true,
    details: { dominancePct: Number.isFinite(current) ? Math.round(current * 100) / 100 : "n/a", change30d: Math.round(change * 100) / 100, direction, usingProxy },
  };
}

export function fundingComponent(funding: Record<string, number>): ComponentResult {
  const id = "funding";
  const rates = Object.values(funding).filter((r) => r !== null && r !== undefined);
  if (rates.some((r) => typeof r !== "number" || !Number.isFinite(r) || Math.abs(r) > 1)) return unavailable(id, "INVALID DATA: funding rate must be finite and between -1 and 1");
  if (rates.length < 2) return unavailable(id, `NO DATA: need funding for ≥ 2 symbols (have ${rates.length})`);
  const avg = mean(rates);
  let score: number;
  let label: string;
  if (avg <= -0.0001) [score, label] = [80, "WASHED OUT (negative funding; shorts paying longs)"];
  else if (avg < 0) [score, label] = [65, "SKEPTICAL (mildly negative funding)"];
  else if (avg <= 0.0001) [score, label] = [75, "NEUTRAL (funding near baseline)"];
  else if (avg <= 0.0003) [score, label] = [55, "WARMING (long leverage building)"];
  else if (avg <= 0.0006) [score, label] = [30, "CROWDED (hot funding; crowded longs)"];
  else [score, label] = [10, "EUPHORIC (extreme funding; cascade risk)"];
  const annualized = avg * 3 * 365 * 100;
  return {
    id,
    label: LABELS[id],
    weight: CRYPTO_COMPONENT_WEIGHTS[id],
    score,
    signal: `${label}; avg ${(avg * 100).toFixed(4)}%/8h (~${annualized.toFixed(1)}% annualised) across ${rates.length} perps`,
    dataAvailable: true,
    details: { avgFunding8h: avg, annualizedPct: Math.round(annualized * 100) / 100, symbols: rates.length },
  };
}

function realizedVol(closes: number[], window: number): number {
  const rets: number[] = [];
  for (let i = closes.length - window + 1; i < closes.length; i++) {
    if (i >= 1 && closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i]) - Math.log(closes[i - 1]));
  }
  if (rets.length < 2) return 0;
  return stddev(rets, true) * Math.sqrt(365);
}

export function drawdownVolComponent(closes: number[]): ComponentResult {
  const id = "drawdown_vol";
  if (closes.length < 365) return unavailable(id, `NO DATA: need ≥ 365 daily closes (have ${closes.length})`);
  const window = closes.slice(-365);
  const high = Math.max(...window);
  const price = closes[closes.length - 1];
  const dd = high > 0 ? 1 - price / high : 0;
  let score = dd <= 0.1 ? 90 : dd <= 0.2 ? 75 : dd <= 0.35 ? 55 : dd <= 0.5 ? 35 : dd <= 0.65 ? 20 : 10;
  const vols: number[] = [];
  for (let i = 30; i < window.length; i += 7) vols.push(realizedVol(window.slice(0, i + 1), 30));
  const currentVol = realizedVol(window, 30);
  const below = vols.filter((v) => v <= currentVol).length;
  const pct = vols.length ? below / vols.length : 0.5;
  let mod = "";
  if (pct <= 1 / 3) {
    score += 10;
    mod = "; volatility compressed (bottom third of 1y range)";
  } else if (pct >= 2 / 3) {
    score -= 10;
    mod = "; volatility elevated (top third of 1y range)";
  }
  if (dd > 0.65 && pct >= 2 / 3) {
    score = Math.max(score, 15);
    mod += "; capitulation-zone contrarian floor applied";
  }
  score = Math.max(0, Math.min(100, score));
  return {
    id,
    label: LABELS[id],
    weight: CRYPTO_COMPONENT_WEIGHTS[id],
    score,
    signal: `Drawdown ${(dd * 100).toFixed(1)}% from 1y high${mod}`,
    dataAvailable: true,
    details: { drawdownPct: Math.round(dd * 10000) / 100, realizedVol30d: Math.round(currentVol * 10000) / 10000, volPercentile1y: Math.round(pct * 100) / 100 },
  };
}

export function momentumThrustComponent(series: Record<string, number[]>): ComponentResult {
  const id = "momentum_thrust";
  const LOOKBACK = 30;
  let positive = 0;
  let counted = 0;
  for (const closes of Object.values(series)) {
    if (!closes || closes.length < LOOKBACK + 1) continue;
    counted++;
    if (closes[closes.length - 1] > closes[closes.length - 1 - LOOKBACK]) positive++;
  }
  if (counted < 5) return unavailable(id, `NO DATA: only ${counted} coins with ≥ ${LOOKBACK + 1}d history`);
  const pct = (positive / counted) * 100;
  let score: number;
  let label: string;
  if (pct >= 85) [score, label] = [90, "BROAD THRUST"];
  else if (pct >= 65) [score, label] = [75, "POSITIVE"];
  else if (pct >= 45) [score, label] = [55, "MIXED"];
  else if (pct >= 25) [score, label] = [35, "WEAK"];
  else if (pct >= 10) [score, label] = [20, "BROADLY NEGATIVE"];
  else [score, label] = [35, "WASHOUT (contrarian: near-total negative momentum)"];
  return { id, label: LABELS[id], weight: CRYPTO_COMPONENT_WEIGHTS[id], score, signal: `${label}: ${pct.toFixed(0)}% of ${counted} coins positive over ${LOOKBACK}d`, dataAvailable: true, details: { pctPositive30d: Math.round(pct * 10) / 10, universeSize: counted } };
}

export function compositeScore(components: ComponentResult[], weights: Record<string, number>, minComponents: number, minWeight: number, zones: [number, string, string][]): { score: number | null; zone: string; guidance: string; effectiveWeights: Record<string, number>; available: number } {
  const available = components.filter((c) => c.dataAvailable && weights[c.id] !== undefined);
  const total = available.reduce((s, c) => s + weights[c.id], 0);
  if (available.length < minComponents || total < minWeight) {
    return { score: null, zone: "UNKNOWN", guidance: `Insufficient component coverage for a regime classification (${available.length}/${components.length} components, ${(total * 100).toFixed(0)}% model weight)`, effectiveWeights: {}, available: available.length };
  }
  const eff: Record<string, number> = {};
  let score = 0;
  for (const c of available) {
    eff[c.id] = weights[c.id] / total;
    score += c.score * eff[c.id];
  }
  score = Math.round(Math.max(0, Math.min(100, score)) * 10) / 10;
  let zone = zones[zones.length - 1][1];
  let guidance = zones[zones.length - 1][2];
  for (const [threshold, z, g] of zones) {
    if (score >= threshold) {
      zone = z;
      guidance = g;
      break;
    }
  }
  return { score, zone, guidance, effectiveWeights: eff, available: available.length };
}

const CRYPTO_ZONES: [number, string, string][] = [
  [80, "RISK_ON", "Broad risk-on conditions observed; review risk limits before decisions"],
  [40, "NEUTRAL", "Mixed conditions observed; no strong regime conclusion"],
  [0, "RISK_OFF", "Defensive market conditions observed; review existing risk controls"],
];

export function analyzeCryptoRegime(input: CryptoRegimeInput): CryptoRegimeResult {
  const btc = btcTrendComponent(input.btcDailyCloses);
  const btcTrendUp = btc.dataAvailable && btc.score >= 60;
  const components = [
    btc,
    altBreadthComponent(input.altDailyCloses),
    dominanceComponent(input.dominanceSeries, btcTrendUp, input.dominanceProxySeries, input.currentDominance),
    fundingComponent(input.funding),
    drawdownVolComponent(input.btcDailyCloses),
    momentumThrustComponent({ BTC: input.btcDailyCloses, ...input.altDailyCloses }),
  ];
  const comp = compositeScore(components, CRYPTO_COMPONENT_WEIGHTS, MIN_AVAILABLE_COMPONENTS, MIN_AVAILABLE_WEIGHT, CRYPTO_ZONES);
  return {
    score: comp.score,
    zone: comp.zone as RegimeZone,
    guidance: comp.guidance,
    components,
    effectiveWeights: comp.effectiveWeights,
    componentsAvailable: comp.available,
    asOf: input.asOf,
    methodology: "6-component weighted composite (BTC trend 25%, alt breadth 20%, dominance 15%, funding 15%, drawdown/vol 15%, momentum 10%); missing components redistribute weight. Adapted from tradermonty/claude-trading-skills crypto-regime-analyzer (MIT). Heuristic, not a win probability.",
  };
}

/** Builds a BTC relative-strength ratio series vs. a market-cap-weighted alt basket. */
export function dominanceProxyFromCloses(btc: number[], alts: Record<string, number[]>, weights?: Record<string, number>): number[] {
  const symbols = Object.keys(alts).filter((s) => alts[s].length >= 31);
  if (symbols.length === 0) return [];
  const n = Math.min(btc.length, ...symbols.map((s) => alts[s].length));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let basket = 0;
    let wsum = 0;
    for (const s of symbols) {
      const series = alts[s];
      const base = series[series.length - n];
      const v = series[series.length - n + i];
      if (base > 0) {
        const w = weights?.[s] ?? 1;
        basket += (v / base) * w;
        wsum += w;
      }
    }
    const btcBase = btc[btc.length - n];
    const btcV = btc[btc.length - n + i];
    out.push(wsum > 0 && btcBase > 0 ? btcV / btcBase / (basket / wsum) : NaN);
  }
  return out.filter((v) => Number.isFinite(v));
}

export { sma as _sma };

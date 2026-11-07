/**
 * Gold Macro-Technical Posture — a transparent 0-100 heuristic for XAU/USD built in the
 * same spirit as the crypto regime analyzer (weighted components, proportional
 * redistribution when data is missing, fail-closed to UNKNOWN on sparse coverage).
 *
 * The dollar component deliberately MEASURES the current gold/DXY relationship instead
 * of assuming an inverse correlation. Scores are descriptive, not predictive.
 */
import { mean, stddev } from "../math";
import { rsi, macd, atr } from "../indicators";
import type { Candle } from "../types";
import { compositeScore, type ComponentResult } from "./crypto";

export interface GoldRegimeInput {
  goldDaily: Candle[];
  dxyDaily?: number[]; // index level, oldest -> newest
  tenYearYield?: number[]; // percent
  realYield10y?: number[]; // percent (TIPS)
  asOf: number;
  dxyLabel?: string;
  yieldLabel?: string;
}

export const GOLD_COMPONENT_WEIGHTS: Record<string, number> = {
  gold_trend: 0.3,
  dollar: 0.2,
  rates: 0.2,
  momentum: 0.15,
  volatility: 0.15,
};

const LABELS: Record<string, string> = {
  gold_trend: "Gold Trend Structure",
  dollar: "US Dollar Backdrop",
  rates: "Real / Nominal Yield Backdrop",
  momentum: "Daily Momentum (RSI / MACD)",
  volatility: "Volatility Regime (ATR percentile)",
};

const ZONES: [number, string, string][] = [
  [70, "CONSTRUCTIVE", "Trend, macro backdrop and momentum are mostly supportive; manage risk at structure"],
  [40, "MIXED", "Conflicting signals between trend and macro backdrop; selective, confirmation-based trading"],
  [0, "DEFENSIVE", "Trend or macro backdrop is working against gold; favour patience or counter-trend discipline"],
];

function unavailable(id: string, signal: string): ComponentResult {
  return { id, label: LABELS[id], weight: GOLD_COMPONENT_WEIGHTS[id], score: 50, signal, dataAvailable: false, details: {} };
}

export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 5) return NaN;
  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < n; i++) {
    const a0 = a[a.length - n + i - 1];
    const a1 = a[a.length - n + i];
    const b0 = b[b.length - n + i - 1];
    const b1 = b[b.length - n + i];
    if (a0 > 0 && b0 > 0) {
      ra.push(Math.log(a1 / a0));
      rb.push(Math.log(b1 / b0));
    }
  }
  if (ra.length < 5) return NaN;
  const ma = mean(ra);
  const mb = mean(rb);
  let cov = 0;
  for (let i = 0; i < ra.length; i++) cov += (ra[i] - ma) * (rb[i] - mb);
  const sa = stddev(ra, false) * Math.sqrt(ra.length);
  const sb = stddev(rb, false) * Math.sqrt(rb.length);
  return sa > 0 && sb > 0 ? cov / (sa * sb) : NaN;
}

export function goldTrendComponent(closes: number[]): ComponentResult {
  const id = "gold_trend";
  if (closes.length < 220) return unavailable(id, `NO DATA: need ≥ 220 daily closes (have ${closes.length})`);
  const price = closes[closes.length - 1];
  const ma50 = mean(closes.slice(-50));
  const ma200 = mean(closes.slice(-200));
  const ma200Prev = mean(closes.slice(-220, -20));
  const direction = ma200 > ma200Prev * 1.0005 ? "rising" : ma200 < ma200Prev * 0.9995 ? "falling" : "flat";
  let base: number;
  let structure: string;
  if (price > ma50 && ma50 > ma200) [base, structure] = [90, "BULL STACK (price > 50DMA > 200DMA)"];
  else if (price > ma200 && price <= ma50 && ma50 > ma200) [base, structure] = [65, "BULL PULLBACK (price between 200DMA and 50DMA)"];
  else if (price <= ma200 && ma50 > ma200) [base, structure] = [55, "STACK INTACT, PRICE BELOW 200DMA"];
  else if (price > ma50 && ma50 <= ma200) [base, structure] = [45, "RECOVERY ATTEMPT (price above 50DMA, 50 < 200)"];
  else [base, structure] = [15, "BEAR STACK (price < 50DMA < 200DMA)"];
  const score = Math.max(0, Math.min(100, base + (direction === "rising" ? 10 : direction === "falling" ? -10 : 0)));
  const ext = ((price - ma50) / ma50) * 100;
  let signal = `${structure}; 200DMA ${direction}`;
  if (Math.abs(ext) > 6) signal += `; price ${ext > 0 ? "extended" : "depressed"} ${ext.toFixed(1)}% vs 50DMA`;
  return { id, label: LABELS[id], weight: GOLD_COMPONENT_WEIGHTS[id], score, signal, dataAvailable: true, details: { price, ma50, ma200, ma200Direction: direction, extensionVs50dmaPct: Math.round(ext * 10) / 10 } };
}

export function dollarComponent(gold: number[], dxy?: number[], label = "DXY"): ComponentResult {
  const id = "dollar";
  if (!dxy || dxy.length < 61) return unavailable(id, `NO DATA: need ≥ 61 daily ${label} observations`);
  const now = dxy[dxy.length - 1];
  const chg20 = ((now - dxy[dxy.length - 21]) / dxy[dxy.length - 21]) * 100;
  const chg60 = ((now - dxy[dxy.length - 61]) / dxy[dxy.length - 61]) * 100;
  const corr = correlation(gold.slice(-61), dxy.slice(-61));
  let score: number;
  let reading: string;
  if (chg20 < -1 && chg60 < 0) [score, reading] = [80, "dollar weakening (tailwind if the inverse relationship holds)"];
  else if (chg20 < -0.3) [score, reading] = [65, "dollar softening"];
  else if (chg20 > 1 && chg60 > 0) [score, reading] = [25, "dollar strengthening (headwind if the inverse relationship holds)"];
  else if (chg20 > 0.3) [score, reading] = [40, "dollar firming"];
  else [score, reading] = [55, "dollar range-bound"];
  let corrNote = "";
  if (Number.isFinite(corr)) {
    if (Math.abs(corr) < 0.3) {
      score = Math.round(score * 0.5 + 55 * 0.5);
      corrNote = `; 60d gold/${label} correlation is weak (${corr.toFixed(2)}) — dollar signal discounted`;
    } else if (corr > 0.3) {
      // Gold and the dollar rising together (e.g. safe-haven bid) — invert the reading's sign.
      score = 100 - score;
      corrNote = `; 60d correlation is POSITIVE (${corr.toFixed(2)}) — gold is trading WITH the dollar, inverse assumption does not hold`;
    } else corrNote = `; 60d correlation ${corr.toFixed(2)} (inverse relationship currently intact)`;
  }
  return {
    id,
    label: LABELS[id],
    weight: GOLD_COMPONENT_WEIGHTS[id],
    score: Math.max(0, Math.min(100, score)),
    signal: `${label} ${chg20 >= 0 ? "+" : ""}${chg20.toFixed(2)}% / 20d, ${chg60 >= 0 ? "+" : ""}${chg60.toFixed(2)}% / 60d — ${reading}${corrNote}`,
    dataAvailable: true,
    details: { level: Math.round(now * 1000) / 1000, change20dPct: Math.round(chg20 * 100) / 100, change60dPct: Math.round(chg60 * 100) / 100, corr60d: Number.isFinite(corr) ? Math.round(corr * 100) / 100 : "n/a" },
  };
}

export function ratesComponent(realYield?: number[], nominal?: number[], label = "10y"): ComponentResult {
  const id = "rates";
  const series = realYield && realYield.length >= 21 ? realYield : nominal && nominal.length >= 21 ? nominal : null;
  const kind = realYield && realYield.length >= 21 ? "real 10y yield (TIPS)" : "nominal 10y yield";
  if (!series) return unavailable(id, `NO DATA: need ≥ 21 daily ${label} yield observations`);
  const now = series[series.length - 1];
  const chg20 = now - series[series.length - 21]; // percentage points
  const chg60 = series.length >= 61 ? now - series[series.length - 61] : NaN;
  let score: number;
  let reading: string;
  if (chg20 <= -0.2) [score, reading] = [80, "yields falling sharply (lower opportunity cost of holding gold)"];
  else if (chg20 < -0.05) [score, reading] = [65, "yields drifting lower"];
  else if (chg20 >= 0.2) [score, reading] = [25, "yields rising sharply (higher opportunity cost of holding gold)"];
  else if (chg20 > 0.05) [score, reading] = [40, "yields drifting higher"];
  else [score, reading] = [55, "yields stable"];
  if (kind.startsWith("nominal")) score = Math.round(score * 0.7 + 55 * 0.3);
  return {
    id,
    label: LABELS[id],
    weight: GOLD_COMPONENT_WEIGHTS[id],
    score,
    signal: `${kind} ${now.toFixed(2)}% (${chg20 >= 0 ? "+" : ""}${(chg20 * 100).toFixed(0)}bp / 20d${Number.isFinite(chg60) ? `, ${chg60 >= 0 ? "+" : ""}${(chg60 * 100).toFixed(0)}bp / 60d` : ""}) — ${reading}${kind.startsWith("nominal") ? "; real-yield data unavailable, nominal used with reduced weight" : ""}`,
    dataAvailable: true,
    details: { level: now, change20dBp: Math.round(chg20 * 100), seriesKind: kind },
  };
}

export function momentumComponent(closes: number[]): ComponentResult {
  const id = "momentum";
  if (closes.length < 40) return unavailable(id, "NO DATA: need ≥ 40 daily closes");
  const r = rsi(closes, 14);
  const m = macd(closes);
  const rv = r[r.length - 1];
  const hist = m.histogram[m.histogram.length - 1];
  const histPrev = m.histogram[m.histogram.length - 2];
  let score: number;
  let reading: string;
  if (rv >= 50 && rv < 70 && hist > 0) [score, reading] = [80, "bullish momentum with room (RSI 50-70, MACD histogram positive)"];
  else if (rv >= 70) [score, reading] = [hist > 0 ? 60 : 45, "overbought — strong trend but stretched"];
  else if (rv >= 40 && rv < 50) [score, reading] = [hist > histPrev ? 50 : 40, "momentum neutral-to-soft"];
  else if (rv >= 30) [score, reading] = [hist > histPrev ? 35 : 25, "bearish momentum"];
  else [score, reading] = [35, "oversold washout — contrarian bounce watch"];
  return { id, label: LABELS[id], weight: GOLD_COMPONENT_WEIGHTS[id], score, signal: `RSI14 ${rv.toFixed(1)}, MACD histogram ${hist >= 0 ? "+" : ""}${hist.toFixed(2)} (${hist > histPrev ? "expanding" : "contracting"}) — ${reading}`, dataAvailable: true, details: { rsi14: Math.round(rv * 10) / 10, macdHistogram: Math.round(hist * 100) / 100 } };
}

export function volatilityComponent(candles: Candle[]): ComponentResult {
  const id = "volatility";
  if (candles.length < 120) return unavailable(id, "NO DATA: need ≥ 120 daily candles");
  const a = atr(candles, 14);
  const pcts: number[] = [];
  for (let i = 14; i < candles.length; i++) if (!Number.isNaN(a[i])) pcts.push((a[i] / candles[i].close) * 100);
  const current = pcts[pcts.length - 1];
  const window = pcts.slice(-252);
  const below = window.filter((v) => v <= current).length;
  const pct = below / window.length;
  let score: number;
  let reading: string;
  if (pct <= 1 / 3) [score, reading] = [70, "volatility compressed — trends often extend from compression"];
  else if (pct >= 2 / 3) [score, reading] = [35, "volatility elevated — wider stops, smaller size"];
  else [score, reading] = [55, "volatility normal"];
  return { id, label: LABELS[id], weight: GOLD_COMPONENT_WEIGHTS[id], score, signal: `ATR(14) ${current.toFixed(2)}% of price, ${(pct * 100).toFixed(0)}th percentile of the last year — ${reading}`, dataAvailable: true, details: { atrPct: Math.round(current * 100) / 100, percentile1y: Math.round(pct * 100) / 100 } };
}

export interface GoldRegimeResult {
  score: number | null;
  zone: "CONSTRUCTIVE" | "MIXED" | "DEFENSIVE" | "UNKNOWN";
  guidance: string;
  components: ComponentResult[];
  effectiveWeights: Record<string, number>;
  asOf: number;
  methodology: string;
}

export function analyzeGoldRegime(input: GoldRegimeInput): GoldRegimeResult {
  const closes = input.goldDaily.map((c) => c.close);
  const components = [
    goldTrendComponent(closes),
    dollarComponent(closes, input.dxyDaily, input.dxyLabel),
    ratesComponent(input.realYield10y, input.tenYearYield, input.yieldLabel),
    momentumComponent(closes),
    volatilityComponent(input.goldDaily),
  ];
  const comp = compositeScore(components, GOLD_COMPONENT_WEIGHTS, 3, 0.6, ZONES);
  return {
    score: comp.score,
    zone: comp.zone as GoldRegimeResult["zone"],
    guidance: comp.guidance,
    components,
    effectiveWeights: comp.effectiveWeights,
    asOf: input.asOf,
    methodology: "5-component weighted composite (gold trend 30%, dollar 20%, yields 20%, momentum 15%, volatility 15%). The dollar component measures the realised 60-day gold/dollar correlation rather than assuming an inverse relationship. Heuristic posture, not a forecast.",
  };
}

/**
 * Multi-timeframe analyzer. Each timeframe gets an independent, rule-based bias and
 * strength; the overall bias weights higher timeframes more heavily and the result
 * explains any conflicts explicitly instead of hiding them.
 */
import type { Candle, Timeframe, AssetId, Bias } from "../types";
import { resolveAsset } from "../types";
import { computeIndicatorSnapshot, type IndicatorSnapshot } from "../indicators";
import { findSwings, classifyStructure, supportResistance, type StructureSummary, type SRLevel } from "../structure";
import { validateCandles, type QualityReport } from "../quality";

export interface TimeframeAnalysis {
  timeframe: Timeframe;
  bias: Bias;
  /** Signed score: positive bullish, negative bearish (range ±8). */
  score: number;
  strength: number; // 0..100
  trend: StructureSummary["trend"];
  indicators: IndicatorSnapshot;
  structure: StructureSummary;
  support: SRLevel[];
  resistance: SRLevel[];
  notes: string[];
  quality: QualityReport;
  bars: number;
  lastBarTime: number;
}

export const TF_WEIGHTS: Record<Timeframe, number> = { "5m": 0.05, "15m": 0.1, "1h": 0.2, "4h": 0.3, "1d": 0.35, "1w": 0.25 };

export function analyzeTimeframe(candles: Candle[], timeframe: Timeframe, now: number, allowGaps = false): TimeframeAnalysis | null {
  const quality = validateCandles(candles, timeframe, now, { minBars: 60, allowGaps });
  const ind = computeIndicatorSnapshot(candles);
  if (!ind) return null;
  const swings = findSwings(candles, 3, 3);
  const structure = classifyStructure(candles, swings);
  const { support, resistance } = supportResistance(candles, swings, ind.atr14, timeframe);
  const notes: string[] = [];
  let score = 0;
  const price = ind.close;

  // EMA stack and position
  if (ind.emaStack === "bullish") {
    score += 2;
    notes.push("EMA 20 > 50 > 200 — bullish moving-average stack");
  } else if (ind.emaStack === "bearish") {
    score -= 2;
    notes.push("EMA 20 < 50 < 200 — bearish moving-average stack");
  } else notes.push("Moving averages intertwined — no clean stack");
  if (!Number.isNaN(ind.ema50)) {
    if (price > ind.ema50) score += 1;
    else score -= 1;
  }
  if (!Number.isNaN(ind.ema200)) {
    if (price > ind.ema200) {
      score += 1;
      notes.push(`Price above EMA200 (${fmt(ind.ema200)})`);
    } else {
      score -= 1;
      notes.push(`Price below EMA200 (${fmt(ind.ema200)})`);
    }
  }
  // Structure
  if (structure.trend === "uptrend") {
    score += 2;
    notes.push(structure.description);
  } else if (structure.trend === "downtrend") {
    score -= 2;
    notes.push(structure.description);
  } else notes.push(structure.description);
  if (structure.breakout) {
    score += structure.breakout.type === "bullish" ? 1 : -1;
    notes.push(`${structure.breakout.type === "bullish" ? "Breakout above" : "Breakdown below"} ${fmt(structure.breakout.level)} ${structure.breakout.barsAgo === 0 ? "on the latest bar" : `${structure.breakout.barsAgo} bars ago`}`);
  }
  // Momentum
  if (!Number.isNaN(ind.macd.histogram)) {
    if (ind.macd.histogram > 0) score += 1;
    else if (ind.macd.histogram < 0) score -= 1;
    notes.push(`MACD histogram ${ind.macd.histogram > 0 ? "positive" : "negative"} and ${Math.abs(ind.macd.histogram) > Math.abs(ind.macd.histogramPrev) ? "expanding" : "contracting"}${ind.macd.cross.endsWith("cross") ? ` (${ind.macd.cross.replace("_", " ")} on the last bar)` : ""}`);
  }
  if (!Number.isNaN(ind.rsi14)) {
    if (ind.rsi14 > 55) score += 1;
    else if (ind.rsi14 < 45) score -= 1;
    const state = ind.rsi14 >= 70 ? "overbought" : ind.rsi14 <= 30 ? "oversold" : ind.rsi14 > 55 ? "bullish zone" : ind.rsi14 < 45 ? "bearish zone" : "neutral";
    notes.push(`RSI(14) ${ind.rsi14.toFixed(1)} — ${state}`);
  }
  // Volatility / trend strength
  const adxFactor = Number.isNaN(ind.adx14) ? 0.8 : ind.adx14 >= 25 ? 1 : ind.adx14 >= 18 ? 0.85 : 0.65;
  if (!Number.isNaN(ind.adx14)) notes.push(`ADX ${ind.adx14.toFixed(0)} — ${ind.adx14 >= 25 ? "trending" : ind.adx14 >= 18 ? "developing trend" : "weak / ranging"}`);
  if (ind.bollinger.squeeze) notes.push("Bollinger bandwidth in the bottom 20% of its range — volatility squeeze");
  if (ind.volume) {
    if (ind.volume.spike) notes.push(`Volume spike: ${ind.volume.relativeVolume.toFixed(1)}x the 20-bar average`);
    else if (ind.volume.relativeVolume < 0.6) notes.push("Volume well below average — low conviction");
  }
  const bias: Bias = score >= 3 ? "bullish" : score <= -3 ? "bearish" : "neutral";
  const strength = Math.round(Math.min(100, (Math.abs(score) / 8) * 100 * adxFactor));
  const lastBar = candles[candles.length - 1];
  return { timeframe, bias, score, strength, trend: structure.trend, indicators: ind, structure, support, resistance, notes, quality, bars: candles.length, lastBarTime: lastBar.time };
}

export interface MtfResult {
  assetId: AssetId;
  overallBias: Bias;
  overallScore: number; // weighted -8..8
  alignment: "aligned" | "partial" | "conflicting";
  alignmentPct: number;
  keySupport: number | null;
  keyResistance: number | null;
  entryArea: { low: number; high: number; basis: string } | null;
  confirmations: string[];
  invalidations: string[];
  conflicts: string[];
  worthConsidering: boolean;
  summary: string[];
  perTimeframe: TimeframeAnalysis[];
  asOf: number;
  price: number;
}

export function analyzeMultiTimeframe(assetId: AssetId, byTimeframe: Partial<Record<Timeframe, Candle[]>>, now: number): MtfResult {
  const meta = resolveAsset(assetId);
  const per: TimeframeAnalysis[] = [];
  for (const tf of Object.keys(byTimeframe) as Timeframe[]) {
    const candles = byTimeframe[tf];
    if (!candles || candles.length === 0) continue;
    const a = analyzeTimeframe(candles, tf, now, !meta.continuous);
    if (a) per.push(a);
  }
  const order: Timeframe[] = ["5m", "15m", "1h", "4h", "1d", "1w"];
  per.sort((a, b) => order.indexOf(a.timeframe) - order.indexOf(b.timeframe));
  const price = per.length ? per[per.length - 1].indicators.close : NaN;
  const totalW = per.reduce((s, a) => s + TF_WEIGHTS[a.timeframe], 0);
  const overallScore = totalW ? per.reduce((s, a) => s + a.score * TF_WEIGHTS[a.timeframe], 0) / totalW : 0;
  const overallBias: Bias = overallScore >= 2 ? "bullish" : overallScore <= -2 ? "bearish" : "neutral";
  const sign = Math.sign(overallScore);
  const agreeing = per.filter((a) => (sign === 0 ? a.bias === "neutral" : Math.sign(a.score) === sign && a.bias !== "neutral")).reduce((s, a) => s + TF_WEIGHTS[a.timeframe], 0);
  const alignmentPct = totalW ? Math.round((agreeing / totalW) * 100) : 0;
  const alignment = alignmentPct >= 75 ? "aligned" : alignmentPct >= 45 ? "partial" : "conflicting";

  // Key levels: prefer 4h/1d structure, nearest to price.
  const htf = per.filter((a) => a.timeframe === "4h" || a.timeframe === "1d");
  const pool = htf.length ? htf : per;
  const supports = pool.flatMap((a) => a.support).sort((a, b) => b.price - a.price);
  const resistances = pool.flatMap((a) => a.resistance).sort((a, b) => a.price - b.price);
  const keySupport = supports[0]?.price ?? null;
  const keyResistance = resistances[0]?.price ?? null;

  const conflicts: string[] = [];
  const confirmations: string[] = [];
  const invalidations: string[] = [];
  const summary: string[] = [];
  const high = per.filter((a) => a.timeframe === "1d" || a.timeframe === "1w");
  const low = per.filter((a) => a.timeframe === "5m" || a.timeframe === "15m" || a.timeframe === "1h");
  const htfBias = high.length ? (high.reduce((s, a) => s + a.score, 0) / high.length >= 2 ? "bullish" : high.reduce((s, a) => s + a.score, 0) / high.length <= -2 ? "bearish" : "neutral") : "neutral";
  const ltfBias = low.length ? (low.reduce((s, a) => s + a.score, 0) / low.length >= 2 ? "bullish" : low.reduce((s, a) => s + a.score, 0) / low.length <= -2 ? "bearish" : "neutral") : "neutral";
  if (htfBias !== "neutral" && ltfBias !== "neutral" && htfBias !== ltfBias) {
    conflicts.push(`Higher timeframes are ${htfBias} while lower timeframes are ${ltfBias}: short-term direction is running against the primary trend. Treat the lower-timeframe move as a counter-trend pullback unless the daily structure breaks.`);
  }
  for (const a of per) {
    if (a.bias !== "neutral" && a.bias !== overallBias && overallBias !== "neutral") conflicts.push(`${a.timeframe}: ${a.bias} (${a.notes[0] ?? ""})`);
    if (a.quality.stale) conflicts.push(`${a.timeframe}: data is stale (${a.quality.issues.find((i) => i.code === "stale")?.message ?? ""})`);
  }

  let entryArea: MtfResult["entryArea"] = null;
  const exec = per.find((a) => a.timeframe === "4h") ?? per.find((a) => a.timeframe === "1h") ?? per[per.length - 1];
  if (exec && overallBias !== "neutral") {
    const ind = exec.indicators;
    if (overallBias === "bullish") {
      const lo = Math.min(ind.ema50, keySupport ?? ind.ema50);
      const hi = Math.max(ind.ema20, lo);
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi <= price) entryArea = { low: lo, high: hi, basis: `${exec.timeframe} EMA20–EMA50 pullback zone${keySupport ? ` overlapping support ${fmt(keySupport)}` : ""}` };
      confirmations.push(`Hold above ${exec.timeframe} EMA50 (${fmt(ind.ema50)}) and print a higher low`);
      confirmations.push(`${exec.timeframe} close back above EMA20 (${fmt(ind.ema20)}) with MACD histogram turning up`);
      if (keyResistance) confirmations.push(`Daily close above ${fmt(keyResistance)} would confirm continuation`);
      if (keySupport) invalidations.push(`Close below ${fmt(keySupport)} (key support) on the ${exec.timeframe}`);
      if (!Number.isNaN(ind.ema200)) invalidations.push(`Loss of EMA200 (${fmt(ind.ema200)}) on the ${exec.timeframe}`);
      if (exec.structure.lastSwingLow) invalidations.push(`Break below the last higher low at ${fmt(exec.structure.lastSwingLow.price)}`);
    } else {
      const hi = Math.max(ind.ema50, keyResistance ?? ind.ema50);
      const lo = Math.min(ind.ema20, hi);
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= price) entryArea = { low: lo, high: hi, basis: `${exec.timeframe} EMA20–EMA50 retracement zone${keyResistance ? ` overlapping resistance ${fmt(keyResistance)}` : ""}` };
      confirmations.push(`Rejection from ${exec.timeframe} EMA50 (${fmt(ind.ema50)}) with a lower high`);
      confirmations.push(`${exec.timeframe} close back below EMA20 (${fmt(ind.ema20)}) with MACD histogram turning down`);
      if (keySupport) confirmations.push(`Daily close below ${fmt(keySupport)} would confirm continuation`);
      if (keyResistance) invalidations.push(`Close above ${fmt(keyResistance)} (key resistance) on the ${exec.timeframe}`);
      if (!Number.isNaN(ind.ema200)) invalidations.push(`Reclaim of EMA200 (${fmt(ind.ema200)}) on the ${exec.timeframe}`);
      if (exec.structure.lastSwingHigh) invalidations.push(`Break above the last lower high at ${fmt(exec.structure.lastSwingHigh.price)}`);
    }
  }
  const stale = per.some((a) => a.quality.stale);
  const worthConsidering = overallBias !== "neutral" && alignment !== "conflicting" && !stale;
  summary.push(`Overall bias: ${overallBias.toUpperCase()} (weighted score ${overallScore.toFixed(1)}; ${alignmentPct}% of timeframe weight agrees — ${alignment}).`);
  for (const a of per) summary.push(`${a.timeframe}: ${a.bias} — ${a.notes.slice(0, 2).join("; ")}.`);
  if (keySupport) summary.push(`Key support ${fmt(keySupport)}; key resistance ${keyResistance ? fmt(keyResistance) : "n/a"}.`);
  if (!worthConsidering) summary.push(stale ? "Data is stale on at least one timeframe — no trade consideration until refreshed." : overallBias === "neutral" ? "No directional edge: timeframes do not agree or momentum is flat." : "Timeframes conflict — wait for alignment.");

  return { assetId, overallBias, overallScore: Math.round(overallScore * 100) / 100, alignment, alignmentPct, keySupport, keyResistance, entryArea, confirmations, invalidations, conflicts, worthConsidering, summary, perTimeframe: per, asOf: now, price };
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "n/a";
  if (Math.abs(v) >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (Math.abs(v) >= 10) return v.toFixed(2);
  return v.toFixed(4);
}

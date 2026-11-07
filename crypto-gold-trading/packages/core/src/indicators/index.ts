/**
 * Deterministic technical indicators. All functions return arrays aligned to the
 * input (NaN during the warm-up period) so values can be plotted against bars.
 *
 * Implementations follow the textbook definitions (Wilder smoothing for RSI/ATR/ADX,
 * SMA-seeded EMA, 12/26/9 MACD, 20/2 Bollinger). They are pure and side-effect free.
 */
import type { Candle } from "../types";
import { mean, stddev } from "../math";

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Relative Strength Index with Wilder smoothing. */
export function rsi(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const fastE = ema(closes, fast);
  const slowE = ema(closes, slow);
  const line = closes.map((_, i) => (Number.isNaN(fastE[i]) || Number.isNaN(slowE[i]) ? NaN : fastE[i] - slowE[i]));
  // Signal EMA is computed on the valid part of the MACD line only.
  const firstValid = line.findIndex((v) => !Number.isNaN(v));
  const signal = new Array<number>(closes.length).fill(NaN);
  const histogram = new Array<number>(closes.length).fill(NaN);
  if (firstValid >= 0) {
    const sig = ema(line.slice(firstValid), signalPeriod);
    for (let i = 0; i < sig.length; i++) {
      signal[firstValid + i] = sig[i];
      if (!Number.isNaN(sig[i])) histogram[firstValid + i] = line[firstValid + i] - sig[i];
    }
  }
  return { macd: line, signal, histogram };
}

export interface BollingerResult {
  middle: number[];
  upper: number[];
  lower: number[];
  /** (upper - lower) / middle */
  bandwidth: number[];
  /** %B: position of close within the bands (0 = lower, 1 = upper). */
  percentB: number[];
}

export function bollinger(closes: number[], period = 20, mult = 2): BollingerResult {
  const middle = sma(closes, period);
  const n = closes.length;
  const upper = new Array<number>(n).fill(NaN);
  const lower = new Array<number>(n).fill(NaN);
  const bandwidth = new Array<number>(n).fill(NaN);
  const percentB = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    const sd = stddev(window, false);
    upper[i] = middle[i] + mult * sd;
    lower[i] = middle[i] - mult * sd;
    bandwidth[i] = middle[i] !== 0 ? (upper[i] - lower[i]) / middle[i] : NaN;
    const range = upper[i] - lower[i];
    percentB[i] = range !== 0 ? (closes[i] - lower[i]) / range : 0.5;
  }
  return { middle, upper, lower, bandwidth, percentB };
}

export function trueRange(candles: Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

/** Average True Range (Wilder). */
export function atr(candles: Candle[], period = 14): number[] {
  const tr = trueRange(candles);
  const out = new Array<number>(candles.length).fill(NaN);
  if (candles.length < period + 1) return out;
  let seed = 0;
  for (let i = 1; i <= period; i++) seed += tr[i];
  let prev = seed / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * Volume-weighted average price, re-anchored whenever `anchorKey` changes.
 * The default anchor is the UTC day, which is the common convention for 24/7 crypto
 * and a reasonable intraday anchor for gold.
 */
export function vwap(candles: Candle[], anchorKey: (c: Candle) => string | number = (c) => Math.floor(c.time / 86_400_000)): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  let key: string | number | undefined;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const k = anchorKey(c);
    if (k !== key) {
      key = k;
      pv = 0;
      vol = 0;
    }
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
    out[i] = vol > 0 ? pv / vol : typical;
  }
  return out;
}

export interface AdxResult {
  adx: number[];
  plusDI: number[];
  minusDI: number[];
}

/** Average Directional Index (Wilder). */
export function adx(candles: Candle[], period = 14): AdxResult {
  const n = candles.length;
  const adxOut = new Array<number>(n).fill(NaN);
  const plusDI = new Array<number>(n).fill(NaN);
  const minusDI = new Array<number>(n).fill(NaN);
  if (n < 2 * period + 1) return { adx: adxOut, plusDI, minusDI };
  const tr = trueRange(candles);
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  let trS = 0;
  let pS = 0;
  let mS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i];
    pS += plusDM[i];
    mS += minusDM[i];
  }
  const dx: number[] = new Array<number>(n).fill(NaN);
  const compute = (i: number) => {
    plusDI[i] = trS === 0 ? 0 : (100 * pS) / trS;
    minusDI[i] = trS === 0 ? 0 : (100 * mS) / trS;
    const sum = plusDI[i] + minusDI[i];
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI[i] - minusDI[i])) / sum;
  };
  compute(period);
  for (let i = period + 1; i < n; i++) {
    trS = trS - trS / period + tr[i];
    pS = pS - pS / period + plusDM[i];
    mS = mS - mS / period + minusDM[i];
    compute(i);
  }
  let adxSeed = 0;
  for (let i = period; i < 2 * period; i++) adxSeed += dx[i];
  let prev = adxSeed / period;
  adxOut[2 * period - 1] = prev;
  for (let i = 2 * period; i < n; i++) {
    prev = (prev * (period - 1) + dx[i]) / period;
    adxOut[i] = prev;
  }
  return { adx: adxOut, plusDI, minusDI };
}

export function obv(candles: Candle[]): number[] {
  const out = new Array<number>(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const dir = Math.sign(candles[i].close - candles[i - 1].close);
    out[i] = out[i - 1] + dir * candles[i].volume;
  }
  return out;
}

export interface VolumeStats {
  lastVolume: number;
  avgVolume: number;
  /** last / average over `period` bars (1.0 = average). */
  relativeVolume: number;
  /** Ratio of up-bar volume to down-bar volume over `period` bars. */
  upDownRatio: number;
  /** Linear slope of the volume SMA over the last `period` bars, normalised by avg volume. */
  trend: "rising" | "falling" | "flat";
  /** OBV slope sign over `period` bars. */
  obvDirection: "rising" | "falling" | "flat";
  /** True when the last bar's volume exceeds 2x the average. */
  spike: boolean;
}

export function volumeStats(candles: Candle[], period = 20): VolumeStats | null {
  if (candles.length < period + 1) return null;
  const recent = candles.slice(-period);
  const vols = recent.map((c) => c.volume);
  const avg = mean(vols);
  const lastVolume = candles[candles.length - 1].volume;
  let up = 0;
  let down = 0;
  for (const c of recent) {
    if (c.close >= c.open) up += c.volume;
    else down += c.volume;
  }
  const firstHalf = mean(vols.slice(0, Math.floor(period / 2)));
  const secondHalf = mean(vols.slice(Math.floor(period / 2)));
  const rel = avg > 0 ? (secondHalf - firstHalf) / avg : 0;
  const obvSeries = obv(candles.slice(-period - 1));
  const obvDelta = obvSeries[obvSeries.length - 1] - obvSeries[0];
  const obvRef = vols.reduce((a, b) => a + b, 0) * 0.05;
  return {
    lastVolume,
    avgVolume: avg,
    relativeVolume: avg > 0 ? lastVolume / avg : 1,
    upDownRatio: down > 0 ? up / down : up > 0 ? Infinity : 1,
    trend: rel > 0.15 ? "rising" : rel < -0.15 ? "falling" : "flat",
    obvDirection: obvDelta > obvRef ? "rising" : obvDelta < -obvRef ? "falling" : "flat",
    spike: avg > 0 && lastVolume > 2 * avg,
  };
}

/** Ordinary least squares slope over the last `window` values (per bar). */
export function slope(values: number[], window: number): number {
  const slice = values.slice(-window).filter((v) => !Number.isNaN(v));
  const n = slice.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = mean(slice);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (slice[i] - yMean);
    den += (i - xMean) * (i - xMean);
  }
  return den === 0 ? 0 : num / den;
}

export type CrossState = "bullish_cross" | "bearish_cross" | "above" | "below" | "unknown";

/** Detects whether `a` crossed `b` on the last bar, or is simply above/below. */
export function crossState(a: number[], b: number[]): CrossState {
  const n = a.length;
  if (n < 2) return "unknown";
  const a1 = a[n - 1];
  const a0 = a[n - 2];
  const b1 = b[n - 1];
  const b0 = b[n - 2];
  if ([a1, a0, b1, b0].some((v) => Number.isNaN(v))) return "unknown";
  if (a0 <= b0 && a1 > b1) return "bullish_cross";
  if (a0 >= b0 && a1 < b1) return "bearish_cross";
  return a1 > b1 ? "above" : "below";
}

/** Realised volatility (annualised) from log returns of closes over `window` bars. */
export function realizedVolatility(closes: number[], window: number, periodsPerYear: number): number {
  const slice = closes.slice(-(window + 1));
  if (slice.length < 3) return NaN;
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1] > 0 && slice[i] > 0) rets.push(Math.log(slice[i]) - Math.log(slice[i - 1]));
  }
  if (rets.length < 2) return NaN;
  return stddev(rets, true) * Math.sqrt(periodsPerYear);
}

export function lastValid(values: number[], offset = 0): number {
  let seen = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    if (!Number.isNaN(values[i])) {
      if (seen === offset) return values[i];
      seen++;
    }
  }
  return NaN;
}

/** Convenience bundle of the standard indicator set used by the analysis engines. */
export interface IndicatorSnapshot {
  close: number;
  rsi14: number;
  rsiPrev: number;
  macd: { line: number; signal: number; histogram: number; histogramPrev: number; cross: CrossState };
  ema20: number;
  ema50: number;
  ema100: number;
  ema200: number;
  emaStack: "bullish" | "bearish" | "mixed";
  ema20Slope: number;
  ema50Slope: number;
  ema200Slope: number;
  vwap: number;
  bollinger: { upper: number; middle: number; lower: number; bandwidth: number; percentB: number; squeeze: boolean };
  atr14: number;
  atrPct: number;
  adx14: number;
  plusDI: number;
  minusDI: number;
  volume: VolumeStats | null;
  bars: number;
}

export function computeIndicatorSnapshot(candles: Candle[]): IndicatorSnapshot | null {
  if (candles.length < 30) return null;
  const closes = candles.map((c) => c.close);
  const r = rsi(closes, 14);
  const m = macd(closes);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e100 = ema(closes, 100);
  const e200 = ema(closes, 200);
  const bb = bollinger(closes, 20, 2);
  const a = atr(candles, 14);
  const ad = adx(candles, 14);
  const vw = vwap(candles);
  const close = closes[closes.length - 1];
  const ema20v = lastValid(e20);
  const ema50v = lastValid(e50);
  const ema100v = lastValid(e100);
  const ema200v = lastValid(e200);
  let emaStack: "bullish" | "bearish" | "mixed" = "mixed";
  if (![ema20v, ema50v, ema200v].some(Number.isNaN)) {
    if (ema20v > ema50v && ema50v > ema200v) emaStack = "bullish";
    else if (ema20v < ema50v && ema50v < ema200v) emaStack = "bearish";
  } else if (!Number.isNaN(ema20v) && !Number.isNaN(ema50v)) {
    emaStack = ema20v > ema50v ? "bullish" : ema20v < ema50v ? "bearish" : "mixed";
  }
  const bwSeries = bb.bandwidth.filter((v) => !Number.isNaN(v));
  const bwLast = lastValid(bb.bandwidth);
  const bwSorted = [...bwSeries.slice(-120)].sort((x, y) => x - y);
  const squeeze = bwSorted.length > 20 && bwLast <= bwSorted[Math.floor(bwSorted.length * 0.2)];
  const atrv = lastValid(a);
  return {
    close,
    rsi14: lastValid(r),
    rsiPrev: lastValid(r, 1),
    macd: {
      line: lastValid(m.macd),
      signal: lastValid(m.signal),
      histogram: lastValid(m.histogram),
      histogramPrev: lastValid(m.histogram, 1),
      cross: crossState(m.macd, m.signal),
    },
    ema20: ema20v,
    ema50: ema50v,
    ema100: ema100v,
    ema200: ema200v,
    emaStack,
    ema20Slope: slope(e20, 5),
    ema50Slope: slope(e50, 10),
    ema200Slope: slope(e200, 20),
    vwap: lastValid(vw),
    bollinger: { upper: lastValid(bb.upper), middle: lastValid(bb.middle), lower: lastValid(bb.lower), bandwidth: bwLast, percentB: lastValid(bb.percentB), squeeze },
    atr14: atrv,
    atrPct: close > 0 ? (atrv / close) * 100 : NaN,
    adx14: lastValid(ad.adx),
    plusDI: lastValid(ad.plusDI),
    minusDI: lastValid(ad.minusDI),
    volume: volumeStats(candles, 20),
    bars: candles.length,
  };
}

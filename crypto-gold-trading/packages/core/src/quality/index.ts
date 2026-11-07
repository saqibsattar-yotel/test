/**
 * Data-quality validation for candle series and quotes. The analysis engines refuse
 * to produce setups on data that fails these checks, and the UI surfaces warnings.
 */
import type { Candle, Timeframe } from "../types";
import { TIMEFRAME_MS } from "../types";
import { isFiniteNumber } from "../math";

export type QualityIssueCode =
  | "empty"
  | "too_few_bars"
  | "non_finite"
  | "non_positive_price"
  | "ohlc_inconsistent"
  | "non_monotonic_time"
  | "duplicate_time"
  | "gap"
  | "stale"
  | "outlier_jump"
  | "negative_volume";

export interface QualityIssue {
  code: QualityIssueCode;
  severity: "error" | "warning";
  message: string;
  index?: number;
}

export interface QualityReport {
  ok: boolean; // no errors
  issues: QualityIssue[];
  bars: number;
  lastBarTime: number | null;
  /** Age of the most recent bar's close relative to `now`, in ms (null if unknown). */
  ageMs: number | null;
  stale: boolean;
}

export interface ValidateOptions {
  minBars?: number;
  /** How many bar-lengths past the expected close until data is considered stale. */
  staleAfterBars?: number;
  /** Tolerate gaps (e.g. gold has weekend closes). */
  allowGaps?: boolean;
  /** Jump threshold as a fraction of price between consecutive closes (default 25%). */
  outlierJumpFraction?: number;
}

export function validateCandles(candles: Candle[], timeframe: Timeframe, now: number, opts: ValidateOptions = {}): QualityReport {
  const issues: QualityIssue[] = [];
  const minBars = opts.minBars ?? 30;
  const barMs = TIMEFRAME_MS[timeframe];
  const staleAfter = opts.staleAfterBars ?? 3;
  const jumpFrac = opts.outlierJumpFraction ?? 0.25;

  if (candles.length === 0) {
    return { ok: false, issues: [{ code: "empty", severity: "error", message: "No candles returned" }], bars: 0, lastBarTime: null, ageMs: null, stale: true };
  }
  if (candles.length < minBars) {
    issues.push({ code: "too_few_bars", severity: "error", message: `Only ${candles.length} bars; need at least ${minBars}` });
  }
  let gapCount = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const nums = [c.time, c.open, c.high, c.low, c.close, c.volume];
    if (!nums.every(isFiniteNumber)) {
      issues.push({ code: "non_finite", severity: "error", message: `Bar ${i} has a non-finite field`, index: i });
      continue;
    }
    if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) {
      issues.push({ code: "non_positive_price", severity: "error", message: `Bar ${i} has a non-positive price`, index: i });
    }
    if (c.volume < 0) issues.push({ code: "negative_volume", severity: "error", message: `Bar ${i} has negative volume`, index: i });
    if (c.high < Math.max(c.open, c.close) - 1e-9 || c.low > Math.min(c.open, c.close) + 1e-9 || c.high < c.low) {
      issues.push({ code: "ohlc_inconsistent", severity: "error", message: `Bar ${i} OHLC is inconsistent (high/low do not bracket open/close)`, index: i });
    }
    if (i > 0) {
      const prev = candles[i - 1];
      if (c.time === prev.time) issues.push({ code: "duplicate_time", severity: "error", message: `Duplicate timestamp at bar ${i}`, index: i });
      else if (c.time < prev.time) issues.push({ code: "non_monotonic_time", severity: "error", message: `Timestamps go backwards at bar ${i}`, index: i });
      else if (c.time - prev.time > barMs * 1.5) gapCount++;
      if (prev.close > 0 && Math.abs(c.close - prev.close) / prev.close > jumpFrac) {
        issues.push({ code: "outlier_jump", severity: "warning", message: `Close moved ${(((c.close - prev.close) / prev.close) * 100).toFixed(1)}% in one bar at index ${i}`, index: i });
      }
    }
  }
  if (gapCount > 0 && !opts.allowGaps) {
    issues.push({ code: "gap", severity: "warning", message: `${gapCount} gap(s) in the series (missing bars)` });
  }
  const lastBar = candles[candles.length - 1];
  const expectedClose = lastBar.time + barMs;
  const ageMs = now - expectedClose;
  const stale = ageMs > barMs * staleAfter;
  if (stale) {
    issues.push({ code: "stale", severity: "warning", message: `Last bar closed ${Math.round(ageMs / 60000)} min ago (more than ${staleAfter} bars)` });
  }
  const ok = !issues.some((i) => i.severity === "error");
  return { ok, issues, bars: candles.length, lastBarTime: lastBar.time, ageMs, stale };
}

export interface QuoteQuality {
  ok: boolean;
  stale: boolean;
  ageMs: number;
  message?: string;
}

export function assessQuoteAge(asOf: number, now: number, maxAgeMs: number): QuoteQuality {
  const ageMs = now - asOf;
  if (!isFiniteNumber(asOf) || asOf <= 0) return { ok: false, stale: true, ageMs: NaN, message: "Quote has no valid timestamp" };
  if (ageMs < -5 * 60_000) return { ok: false, stale: false, ageMs, message: "Quote timestamp is in the future (clock skew?)" };
  if (ageMs > maxAgeMs) return { ok: true, stale: true, ageMs, message: `Quote is ${Math.round(ageMs / 60000)} min old` };
  return { ok: true, stale: false, ageMs };
}

/** Returns true when two independent price sources disagree by more than `tolerancePct`. */
export function pricesDisagree(a: number, b: number, tolerancePct = 1.0): boolean {
  if (!isFiniteNumber(a) || !isFiniteNumber(b) || a <= 0 || b <= 0) return true;
  return (Math.abs(a - b) / ((a + b) / 2)) * 100 > tolerancePct;
}

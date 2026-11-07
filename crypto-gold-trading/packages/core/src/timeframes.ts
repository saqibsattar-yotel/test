import type { Candle, Timeframe } from "./types";
import { TIMEFRAME_MS } from "./types";
import { startOfUtcWeek } from "./time";

/** Aggregates candles of a smaller timeframe into a larger one (UTC-aligned buckets). */
export function resample(candles: Candle[], from: Timeframe, to: Timeframe): Candle[] {
  const fromMs = TIMEFRAME_MS[from];
  const toMs = TIMEFRAME_MS[to];
  if (toMs <= fromMs) return candles.slice();
  const out: Candle[] = [];
  let bucket: Candle | null = null;
  let bucketKey = NaN;
  for (const c of candles) {
    const key = to === "1w" ? startOfUtcWeek(c.time) : Math.floor(c.time / toMs) * toMs;
    if (key !== bucketKey) {
      if (bucket) out.push(bucket);
      bucket = { time: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      bucketKey = key;
    } else if (bucket) {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.volume += c.volume;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

export function timeframeLabel(tf: Timeframe): string {
  return { "5m": "5 min", "15m": "15 min", "1h": "1 hour", "4h": "4 hour", "1d": "Daily", "1w": "Weekly" }[tf];
}

/** Typical holding-period description for a setup traded on `tf`. */
export function expectedHoldFor(tf: Timeframe): string {
  return {
    "5m": "15 minutes to 2 hours",
    "15m": "1 to 8 hours",
    "1h": "6 hours to 2 days",
    "4h": "1 to 7 days",
    "1d": "1 to 4 weeks",
    "1w": "1 to 3 months",
  }[tf];
}

/** The higher timeframe that provides trend context for `tf`. */
export function contextTimeframeFor(tf: Timeframe): Timeframe {
  return { "5m": "1h", "15m": "4h", "1h": "4h", "4h": "1d", "1d": "1w", "1w": "1w" }[tf] as Timeframe;
}

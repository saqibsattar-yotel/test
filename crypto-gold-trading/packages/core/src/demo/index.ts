/**
 * Explicit DEMO data. Generated deterministically from a seed so the UI is stable while
 * developing offline. Every payload built from this module is tagged `quality: "demo"`
 * and the UI shows a DEMO banner — this data must never be presented as live.
 */
import type { Candle, Timeframe, AssetId, DataSource } from "../types";
import { TIMEFRAME_MS } from "../types";

/** Mulberry32 PRNG — small, fast, deterministic. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_ANCHORS: Record<string, number> = {
  BTCUSD: 65000,
  ETHUSD: 2400,
  SOLUSD: 140,
  BNBUSD: 580,
  XRPUSD: 0.55,
  ADAUSD: 0.42,
  DOGEUSD: 0.12,
  AVAXUSD: 28,
  LINKUSD: 13.5,
  XAUUSD: 2650,
};

export function demoCandles(assetId: AssetId, timeframe: Timeframe, count: number, endTime: number, seed = 42): Candle[] {
  const rnd = seededRandom(seed + assetId.length * 31 + timeframe.length * 7);
  const barMs = TIMEFRAME_MS[timeframe];
  const anchor = DEMO_ANCHORS[assetId] ?? 0.5 + (Array.from(assetId).reduce((a, c) => a + c.charCodeAt(0), 0) % 400);
  const volPerBar = (assetId === "XAUUSD" ? 0.0035 : 0.012) * Math.sqrt(barMs / 3_600_000);
  const start = Math.floor(endTime / barMs) * barMs - (count - 1) * barMs;
  const out: Candle[] = [];
  let price = anchor * (0.9 + rnd() * 0.2);
  let drift = 0;
  for (let i = 0; i < count; i++) {
    // Regime-switching drift so demo charts have trends and ranges.
    if (i % 60 === 0) drift = (rnd() - 0.5) * volPerBar * 0.6;
    const shock = (rnd() + rnd() + rnd() - 1.5) * volPerBar * price;
    const open = price;
    const close = Math.max(price * 0.5, open + drift * price + shock);
    const wick = Math.abs(shock) * (0.3 + rnd());
    const high = Math.max(open, close) + wick * rnd();
    const low = Math.min(open, close) - wick * rnd();
    const volume = (anchor > 1000 ? 50 : anchor > 10 ? 20000 : 5_000_000) * (0.5 + rnd() * 1.5) * (1 + Math.abs(shock / price) * 40);
    out.push({ time: start + i * barMs, open, high, low: Math.max(low, 1e-9), close, volume });
    price = close;
  }
  return out;
}

export function demoSource(label: string, now: number): DataSource {
  return { provider: "demo", label: `DEMO — ${label}`, fetchedAt: now, asOf: now, quality: "demo", note: "Synthetic data generated locally. Not real market prices." };
}

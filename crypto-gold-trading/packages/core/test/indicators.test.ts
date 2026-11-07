import { describe, it, expect } from "vitest";
import { sma, ema, rsi, atr, macd, bollinger, vwap, adx, resample, computeIndicatorSnapshot, demoCandles, type Candle } from "../src";

const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13];

describe("indicators", () => {
  it("sma computes simple averages and NaN warm-up", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(out.slice(2)).toEqual([2, 3, 4]);
  });
  it("ema seeds with SMA and converges", () => {
    const out = ema([1, 2, 3, 4, 5, 6], 3);
    expect(out[2]).toBe(2);
    expect(out[3]).toBeCloseTo(3, 10);
    expect(out[5]).toBeCloseTo(5, 1);
  });
  it("rsi matches the classic Wilder worked example (~70.5 then ~66.3)", () => {
    const r = rsi(closes, 14);
    expect(r[14]).toBeCloseTo(70.46, 1);
    expect(r[15]).toBeCloseTo(66.25, 1);
    expect(r[r.length - 1]).toBeGreaterThan(0);
    expect(r[r.length - 1]).toBeLessThan(100);
  });
  it("rsi returns 100 on a monotonic rise and stays within bounds", () => {
    const r = rsi(Array.from({ length: 40 }, (_, i) => 100 + i), 14);
    expect(r[r.length - 1]).toBe(100);
    const r2 = rsi(Array.from({ length: 40 }, (_, i) => 100 - i), 14);
    expect(r2[r2.length - 1]).toBe(0);
  });
  it("atr equals the constant range on a steady series", () => {
    const candles: Candle[] = Array.from({ length: 40 }, (_, i) => ({ time: i * 3600_000, open: 100, high: 102, low: 98, close: 100, volume: 1 }));
    const a = atr(candles, 14);
    expect(a[20]).toBeCloseTo(4, 10);
    expect(Number.isNaN(a[13])).toBe(true);
  });
  it("macd histogram is zero on a flat series and positive in a rising one", () => {
    const flat = macd(new Array(60).fill(100));
    expect(flat.histogram[59]).toBeCloseTo(0, 10);
    const rising = macd(Array.from({ length: 80 }, (_, i) => 100 * Math.pow(1.01, i)));
    expect(rising.macd[79]).toBeGreaterThan(0);
  });
  it("bollinger bands bracket the middle and %B is within range on a sine wave", () => {
    const series = Array.from({ length: 100 }, (_, i) => 100 + 5 * Math.sin(i / 5));
    const bb = bollinger(series, 20, 2);
    const i = 99;
    expect(bb.upper[i]).toBeGreaterThan(bb.middle[i]);
    expect(bb.lower[i]).toBeLessThan(bb.middle[i]);
    expect(bb.percentB[i]).toBeGreaterThanOrEqual(-0.2);
    expect(bb.percentB[i]).toBeLessThanOrEqual(1.2);
  });
  it("vwap re-anchors each UTC day", () => {
    const day = 86_400_000;
    const candles: Candle[] = [
      { time: 0, open: 10, high: 10, low: 10, close: 10, volume: 1 },
      { time: 3600_000, open: 20, high: 20, low: 20, close: 20, volume: 1 },
      { time: day, open: 50, high: 50, low: 50, close: 50, volume: 1 },
    ];
    const v = vwap(candles);
    expect(v[1]).toBeCloseTo(15, 10);
    expect(v[2]).toBeCloseTo(50, 10);
  });
  it("adx is high in a persistent trend and bounded", () => {
    const candles: Candle[] = Array.from({ length: 120 }, (_, i) => ({ time: i * 3600_000, open: 100 + i, high: 101.5 + i, low: 99.5 + i, close: 101 + i, volume: 1 }));
    const a = adx(candles, 14);
    const lastAdx = a.adx[a.adx.length - 1];
    expect(lastAdx).toBeGreaterThan(50);
    expect(lastAdx).toBeLessThanOrEqual(100);
  });
  it("resample aggregates 1h into 4h buckets", () => {
    const candles: Candle[] = Array.from({ length: 8 }, (_, i) => ({ time: i * 3600_000, open: i, high: i + 1, low: i - 1, close: i + 0.5, volume: 1 }));
    const out = resample(candles, "1h", "4h");
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ time: 0, open: 0, high: 4, low: -1, close: 3.5, volume: 4 });
  });
  it("snapshot on demo candles is finite and internally consistent", () => {
    const candles = demoCandles("BTCUSD", "4h", 400, Date.UTC(2026, 10, 7));
    const s = computeIndicatorSnapshot(candles)!;
    expect(s).not.toBeNull();
    expect(Number.isFinite(s.rsi14)).toBe(true);
    expect(Number.isFinite(s.atr14)).toBe(true);
    expect(s.bollinger.upper).toBeGreaterThan(s.bollinger.lower);
    expect(["bullish", "bearish", "mixed"]).toContain(s.emaStack);
  });
});

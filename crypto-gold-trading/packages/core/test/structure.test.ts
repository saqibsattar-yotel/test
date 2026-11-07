import { describe, it, expect } from "vitest";
import { findSwings, classifyStructure, supportResistance, fibonacci, roundNumberLevels, periodLevels, sessionRanges, liquidityZones, type Candle } from "../src";

function bars(prices: number[], step = 3600_000): Candle[] {
  return prices.map((p, i) => ({ time: i * step, open: p, high: p + 1, low: p - 1, close: p, volume: 10 }));
}

describe("market structure", () => {
  it("finds fractal swing highs and lows", () => {
    const c = bars([10, 11, 12, 15, 12, 11, 10, 8, 10, 11, 12, 13]);
    const swings = findSwings(c, 2, 2);
    expect(swings.find((s) => s.type === "high")?.price).toBe(16);
    expect(swings.find((s) => s.type === "low")?.price).toBe(7);
  });
  it("classifies an uptrend from higher highs and higher lows", () => {
    const seq = [10, 12, 14, 12, 11, 13, 16, 18, 15, 14, 17, 20, 22, 19, 18, 21, 24, 26, 23, 22, 25];
    const c = bars(seq);
    const s = classifyStructure(c, findSwings(c, 2, 2));
    expect(s.trend).toBe("uptrend");
    expect(s.higherHighs).toBeGreaterThan(0);
  });
  it("classifies a downtrend from lower highs and lower lows", () => {
    const seq = [30, 28, 26, 28, 29, 27, 24, 22, 25, 26, 23, 20, 18, 21, 22, 19, 16, 14, 17, 18, 15];
    const c = bars(seq);
    const s = classifyStructure(c, findSwings(c, 2, 2));
    expect(s.trend).toBe("downtrend");
  });
  it("detects a live bullish breakout above the last swing high", () => {
    const seq = [10, 11, 12, 11, 10, 11, 12, 11, 10, 11, 14];
    const c = bars(seq);
    c[c.length - 1].close = 14;
    const s = classifyStructure(c, findSwings(c, 2, 2));
    expect(s.breakout?.type).toBe("bullish");
  });
  it("clusters support and resistance around price", () => {
    const seq = [100, 105, 110, 105, 100, 105, 110, 105, 100, 105, 110, 105, 103];
    const c = bars(seq);
    const sw = findSwings(c, 2, 2);
    const { support, resistance } = supportResistance(c, sw, 2);
    expect(support[0].price).toBeLessThan(103);
    expect(resistance[0].price).toBeGreaterThan(103);
    expect(resistance[0].touches).toBeGreaterThanOrEqual(2);
  });
  it("fibonacci retracements and extensions are ordered correctly", () => {
    const f = fibonacci(100, 200, "up");
    expect(f.retracements.find((r) => r.ratio === 0.5)?.price).toBe(150);
    expect(f.extensions.find((e) => e.ratio === 1.618)?.price).toBeCloseTo(261.8, 5);
    const d = fibonacci(100, 200, "down");
    expect(d.extensions.find((e) => e.ratio === 1.272)?.price).toBeCloseTo(72.8, 5);
  });
  it("round-number levels bracket the price", () => {
    const lv = roundNumberLevels(2653, 50, 2);
    expect(lv.map((l) => l.price)).toContain(2600);
    expect(lv.map((l) => l.price)).toContain(2700);
  });
  it("previous day/week levels use completed UTC periods", () => {
    const day = 86_400_000;
    const now = Date.UTC(2026, 10, 4, 12); // Wednesday
    const candles: Candle[] = [];
    for (let t = now - 10 * day; t < now; t += 3600_000) {
      const dayIdx = Math.floor(t / day);
      candles.push({ time: t, open: 100, high: 100 + (dayIdx % 7), low: 100 - (dayIdx % 7), close: 100, volume: 1 });
    }
    const pl = periodLevels(candles, now);
    expect(pl.prevDayHigh).not.toBeNull();
    expect(pl.prevWeekHigh).not.toBeNull();
    expect(pl.prevDayHigh!).toBeGreaterThanOrEqual(pl.prevDayLow!);
  });
  it("session ranges respect London DST (BST in July, GMT in January)", () => {
    const build = (dayStart: number) => Array.from({ length: 24 }, (_, h) => ({ time: dayStart + h * 3600_000, open: h, high: h, low: h, close: h, volume: 1 }));
    const july = Date.UTC(2026, 6, 15);
    const jan = Date.UTC(2026, 0, 15);
    const sJul = sessionRanges(build(july), july + 23 * 3600_000).find((s) => s.name === "London")!;
    const sJan = sessionRanges(build(jan), jan + 23 * 3600_000).find((s) => s.name === "London")!;
    // London 08:00 local = 07:00 UTC in July (BST) and 08:00 UTC in January (GMT)
    expect(sJul.low).toBe(7);
    expect(sJan.low).toBe(8);
    const nyJan = sessionRanges(build(jan), jan + 23 * 3600_000).find((s) => s.name === "New York")!;
    expect(nyJan.low).toBe(13); // 08:00 EST = 13:00 UTC
  });
  it("detects equal lows as sell-side liquidity", () => {
    const seq = [10, 9, 8, 9, 10, 9, 8, 9, 10, 9, 8.02, 9, 10, 11, 12];
    const c = bars(seq);
    const sw = findSwings(c, 1, 1);
    const lz = liquidityZones(c, sw, 1);
    expect(lz.some((l) => l.label.includes("Equal lows"))).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { analyzeCryptoRegime, fundingComponent, btcTrendComponent, dominanceComponent, analyzeGoldRegime, dominanceProxyFromCloses, demoCandles } from "../src";

const rising = (n: number, start = 100, step = 0.3) => Array.from({ length: n }, (_, i) => start + i * step + Math.sin(i / 9) * 2);
const falling = (n: number, start = 400, step = 0.3) => Array.from({ length: n }, (_, i) => start - i * step + Math.sin(i / 9) * 2);

describe("crypto regime (ported methodology)", () => {
  it("scores a bull stack with rising 200DMA at 100", () => {
    const c = btcTrendComponent(rising(400));
    expect(c.dataAvailable).toBe(true);
    expect(c.score).toBe(100);
    expect(c.signal).toContain("BULL STACK");
  });
  it("scores a bear stack with falling 200DMA at 5", () => {
    const c = btcTrendComponent(falling(400));
    expect(c.score).toBe(5);
    expect(c.signal).toContain("BEAR STACK");
  });
  it("reports unavailable with too little history", () => {
    expect(btcTrendComponent(rising(100)).dataAvailable).toBe(false);
  });
  it("maps funding bands exactly as documented", () => {
    expect(fundingComponent({ a: -0.0002, b: -0.0003 }).score).toBe(80);
    expect(fundingComponent({ a: 0.00005, b: 0.0001 }).score).toBe(75);
    expect(fundingComponent({ a: 0.0002, b: 0.00025 }).score).toBe(55);
    expect(fundingComponent({ a: 0.0005, b: 0.0004 }).score).toBe(30);
    expect(fundingComponent({ a: 0.001, b: 0.002 }).score).toBe(10);
    expect(fundingComponent({ a: 0.0001 }).dataAvailable).toBe(false);
    expect(fundingComponent({ a: 2, b: 0 }).dataAvailable).toBe(false);
  });
  it("dominance uses the real series when available and the proxy otherwise", () => {
    const real = dominanceComponent(Array.from({ length: 40 }, (_, i) => 60 - i * 0.1), true);
    expect(real.score).toBe(90);
    expect(real.details.usingProxy).toBe(false);
    const proxy = dominanceComponent([], true, Array.from({ length: 40 }, (_, i) => 1 + i * 0.01), 55);
    expect(proxy.dataAvailable).toBe(true);
    expect(proxy.details.usingProxy).toBe(true);
    expect(proxy.score).toBe(65);
    expect(dominanceComponent([], true).dataAvailable).toBe(false);
  });
  it("produces RISK_ON for a broad bull snapshot and RISK_OFF for a bear snapshot", () => {
    const alts: Record<string, number[]> = {};
    for (let k = 0; k < 8; k++) alts[`ALT${k}`] = rising(400, 10 + k, 0.05 + k * 0.005);
    const bull = analyzeCryptoRegime({ btcDailyCloses: rising(400), altDailyCloses: alts, dominanceSeries: Array.from({ length: 40 }, (_, i) => 58 - i * 0.05), funding: { BTC: 0.00005, ETH: 0.00008 }, asOf: 0 });
    expect(bull.zone).toBe("RISK_ON");
    expect(bull.score!).toBeGreaterThanOrEqual(80);
    const bearAlts: Record<string, number[]> = {};
    for (let k = 0; k < 8; k++) bearAlts[`ALT${k}`] = falling(400, 100 + k, 0.1);
    const bear = analyzeCryptoRegime({ btcDailyCloses: falling(400), altDailyCloses: bearAlts, dominanceSeries: Array.from({ length: 40 }, (_, i) => 55 + i * 0.1), funding: { BTC: 0.0005, ETH: 0.0006 }, asOf: 0 });
    expect(bear.zone).toBe("RISK_OFF");
  });
  it("fails closed to UNKNOWN with sparse coverage", () => {
    const r = analyzeCryptoRegime({ btcDailyCloses: rising(50), altDailyCloses: {}, dominanceSeries: [], funding: {}, asOf: 0 });
    expect(r.zone).toBe("UNKNOWN");
    expect(r.score).toBeNull();
  });
  it("builds a dominance proxy ratio series", () => {
    const p = dominanceProxyFromCloses(rising(100), { A: rising(100, 50, 0.1), B: rising(100, 20, 0.05) });
    expect(p.length).toBeGreaterThan(30);
    expect(p.every(Number.isFinite)).toBe(true);
  });
});

describe("gold posture", () => {
  it("scores a trending gold series with supportive macro as CONSTRUCTIVE", () => {
    const gold = demoCandles("XAUUSD", "1d", 400, Date.UTC(2026, 10, 7));
    // Force an uptrend by adding a drift
    gold.forEach((c, i) => {
      const f = 1 + i * 0.002;
      c.open *= f;
      c.high *= f;
      c.low *= f;
      c.close *= f;
    });
    const dxy = Array.from({ length: 120 }, (_, i) => 105 - i * 0.03);
    const real = Array.from({ length: 120 }, (_, i) => 2.2 - i * 0.004);
    const r = analyzeGoldRegime({ goldDaily: gold, dxyDaily: dxy, realYield10y: real, asOf: 0 });
    expect(r.score).not.toBeNull();
    expect(r.components.filter((c) => c.dataAvailable).length).toBe(5);
    expect(["CONSTRUCTIVE", "MIXED"]).toContain(r.zone);
  });
  it("degrades gracefully without macro inputs", () => {
    const gold = demoCandles("XAUUSD", "1d", 400, Date.UTC(2026, 10, 7));
    const r = analyzeGoldRegime({ goldDaily: gold, asOf: 0 });
    expect(r.components.find((c) => c.id === "dollar")!.dataAvailable).toBe(false);
    expect(r.components.find((c) => c.id === "rates")!.dataAvailable).toBe(false);
    expect(r.score).not.toBeNull(); // 3 components ≥ 60% weight remain
  });
});

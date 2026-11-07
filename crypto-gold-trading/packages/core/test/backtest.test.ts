import { describe, it, expect } from "vitest";
import { runBacktest, computeBacktestStats, demoCandles, type BacktestTrade } from "../src";

describe("backtester", () => {
  const now = Date.UTC(2026, 10, 7, 12);
  it("runs walk-forward on demo data without look-ahead and partitions in/out of sample", () => {
    const candles = demoCandles("BTCUSD", "1h", 1400, now, 11);
    const res = runBacktest(candles, { assetId: "BTCUSD", timeframe: "1h", warmupBars: 260, stepBars: 2 });
    expect(res.bars).toBe(1400);
    expect(res.durationMs).toBeLessThan(60_000);
    for (const t of res.trades) {
      expect(t.entryBar).toBeGreaterThan(t.signalBar);
      expect(t.exitBar).toBeGreaterThanOrEqual(t.entryBar);
      expect(t.entryTime).toBeGreaterThan(t.signalTime);
      if (t.direction === "LONG") expect(t.stop).toBeLessThan(t.entryPrice);
      else expect(t.stop).toBeGreaterThan(t.entryPrice);
      expect(Number.isFinite(t.rMultiple)).toBe(true);
      expect(t.fees).toBeGreaterThan(0);
    }
    expect(res.inSample.trades + res.outOfSample.trades).toBe(res.all.trades);
    expect(res.assumptions.length).toBeGreaterThan(3);
    expect(res.inSampleUntil).toBeGreaterThan(res.periodFrom);
    expect(res.inSampleUntil).toBeLessThan(res.periodTo);
  });
  it("stats: win rate, profit factor, expectancy, drawdown and R buckets from a known trade list", () => {
    const mk = (pnl: number, r: number, i = 0): BacktestTrade => ({ id: i, direction: "LONG", setupType: "breakout", status: "LONG", quality: 70, signalBar: i, signalTime: i, entryBar: i + 1, entryTime: i + 1, entryPrice: 100, stop: 95, targets: [105, 110, 115], exitBar: i + 2, exitTime: i + 2, exitPrice: 100 + r * 5, exitReason: r > 0 ? "tp1" : "stop", rMultiple: r, pnl, fees: 1, quantity: 1, barsHeld: 1, sample: "in" });
    const trades = [mk(200, 2), mk(-100, -1), mk(-100, -1), mk(300, 3)].map((t, i) => ({ ...t, id: i, exitTime: i }));
    const s = computeBacktestStats(trades, 10_000);
    expect(s.trades).toBe(4);
    expect(s.winRate).toBe(50);
    expect(s.profitFactor).toBeCloseTo(500 / 200, 6);
    expect(s.expectancy).toBeCloseTo((200 + 300 - 100 - 100) / 4, 6);
    expect(s.expectancyR).toBeCloseTo((2 - 1 - 1 + 3) / 4, 6);
    expect(s.maxDrawdown).toBe(200);
    expect(s.returnPct).toBeCloseTo(3, 6);
    expect(s.rDistribution.find((b) => b.bucket === "-1R…0")?.count).toBe(0);
    expect(s.rDistribution.find((b) => b.bucket === "≤ -1R")?.count).toBe(2);
    expect(s.rDistribution.find((b) => b.bucket === "2R…3R")?.count).toBe(1);
    expect(s.rDistribution.find((b) => b.bucket === "≥ 3R")?.count).toBe(1);
    expect(s.equityCurve[s.equityCurve.length - 1].equity).toBe(10_300);
  });
  it("respects exit models and costs (higher fees reduce P&L)", () => {
    const candles = demoCandles("ETHUSD", "4h", 900, now, 3);
    const cheap = runBacktest(candles, { assetId: "ETHUSD", timeframe: "4h", feesBps: 0, slippageBps: 0, exitModel: "tp2", stepBars: 2 });
    const costly = runBacktest(candles, { assetId: "ETHUSD", timeframe: "4h", feesBps: 50, slippageBps: 20, exitModel: "tp2", stepBars: 2 });
    expect(cheap.all.trades).toBe(costly.all.trades);
    if (cheap.all.trades > 0) expect(costly.all.totalPnl).toBeLessThan(cheap.all.totalPnl);
    const ladder = runBacktest(candles, { assetId: "ETHUSD", timeframe: "4h", exitModel: "ladder", stepBars: 2 });
    expect(ladder.all.trades).toBeGreaterThanOrEqual(0);
  });
});

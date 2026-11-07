import { describe, it, expect } from "vitest";
import { applyPrice, cancelMonitored, closeMonitored, createMonitored, monitorSummary, type TradeSetup } from "../src";

function setup(direction: "LONG" | "SHORT"): TradeSetup {
  const long = direction === "LONG";
  const now = Date.UTC(2026, 10, 7, 12);
  return {
    id: "st_test",
    assetId: "BTCUSD",
    symbol: "BTC/USD",
    direction,
    status: long ? "LONG" : "SHORT",
    setupType: "trend_pullback",
    timeframe: "4h",
    contextTimeframe: "1d",
    currentPrice: 100,
    entry: long ? { low: 98, high: 100, mid: 99, mode: "limit_zone" } : { low: 100, high: 102, mid: 101, mode: "limit_zone" },
    stopLoss: long ? 95 : 105,
    targets: long
      ? [{ label: "TP1", price: 104, basis: "res", rMultiple: 1.25 }, { label: "TP2", price: 108, basis: "res", rMultiple: 2.25 }, { label: "TP3", price: 112, basis: "ext", rMultiple: 3.25 }]
      : [{ label: "TP1", price: 96, basis: "sup", rMultiple: 1.25 }, { label: "TP2", price: 92, basis: "sup", rMultiple: 2.25 }, { label: "TP3", price: 88, basis: "ext", rMultiple: 3.25 }],
    riskRewardTp1: 1.25,
    riskRewardTp2: 2.25,
    qualityScore: 70,
    confidence: "medium",
    expectedHold: "1 to 7 days",
    regime: "test",
    invalidation: "x",
    expiresAt: now + 24 * 3600_000,
    entryConditions: [],
    supporting: [],
    opposing: [],
    rationale: [],
    dataAsOf: now,
    dataSource: { provider: "test", label: "test", fetchedAt: now, asOf: now, quality: "live" },
    assumptions: [],
    generatedAt: now,
  };
}
const t0 = Date.UTC(2026, 10, 7, 12);

describe("setup monitor", () => {
  it("walks a LONG plan through entry, TP1, TP2 and a stop with ladder outcome", () => {
    let m = createMonitored(setup("LONG"), t0);
    expect(m.status).toBe("watching");
    let r = applyPrice(m, 101, t0 + 1000);
    expect(r.newEvents).toHaveLength(0);
    r = applyPrice(r.next, 99.5, t0 + 2000);
    expect(r.newEvents.map((e) => e.type)).toEqual(["entry_reached"]);
    expect(r.next.entryPrice).toBe(99.5);
    expect(r.newEvents[0].message).toMatch(/No order was placed/);
    r = applyPrice(r.next, 104.2, t0 + 3000);
    expect(r.newEvents.map((e) => e.type)).toEqual(["tp1_reached"]);
    expect(r.next.hits.tp1).toBe(true);
    r = applyPrice(r.next, 104.2, t0 + 3500); // duplicate tick must not re-fire
    expect(r.newEvents).toHaveLength(0);
    r = applyPrice(r.next, 109, t0 + 4000);
    expect(r.newEvents.map((e) => e.type)).toEqual(["tp2_reached"]);
    expect(r.next.mfeR).toBeGreaterThan(2);
    r = applyPrice(r.next, 94.9, t0 + 5000);
    expect(r.newEvents.map((e) => e.type)).toEqual(["stop_reached"]);
    expect(r.next.final).toBe(true);
    expect(r.next.status).toBe("stopped");
    // thirds: TP1 1.25/3 + TP2 2.25/3 + remaining third at -1R
    expect(r.next.outcomeR).toBeCloseTo((1.25 + 2.25) / 3 - 1 / 3, 2);
    expect(applyPrice(r.next, 120, t0 + 6000).newEvents).toHaveLength(0);
  });
  it("fires multiple targets in one tick and completes at TP3", () => {
    let m = createMonitored(setup("LONG"), t0);
    m = applyPrice(m, 99, t0 + 1).next;
    const r = applyPrice(m, 113, t0 + 2);
    expect(r.newEvents.map((e) => e.type)).toEqual(["tp1_reached", "tp2_reached", "tp3_reached"]);
    expect(r.next.status).toBe("tp3_reached");
    expect(r.next.outcomeR).toBeCloseTo((1.25 + 2.25 + 3.25) / 3, 2);
  });
  it("treats a gap through the zone as entry at the zone edge, then evaluates the stop", () => {
    const m = createMonitored(setup("LONG"), t0);
    const r = applyPrice(m, 94, t0 + 1);
    expect(r.newEvents.map((e) => e.type)).toEqual(["entry_reached", "stop_reached"]);
    expect(r.next.entryPrice).toBe(98);
    expect(r.next.outcomeR).toBe(-1);
  });
  it("mirrors the logic for SHORT plans and expires untriggered plans", () => {
    let m = createMonitored(setup("SHORT"), t0);
    let r = applyPrice(m, 101, t0 + 1);
    expect(r.newEvents.map((e) => e.type)).toEqual(["entry_reached"]);
    r = applyPrice(r.next, 95.9, t0 + 2);
    expect(r.newEvents.map((e) => e.type)).toEqual(["tp1_reached"]);
    r = applyPrice(r.next, 105.1, t0 + 3);
    expect(r.next.status).toBe("stopped");
    const e = applyPrice(createMonitored(setup("SHORT"), t0), 99, t0 + 25 * 3600_000);
    expect(e.next.status).toBe("expired");
    expect(e.next.final).toBe(true);
  });
  it("supports cancel and manual close with outcome in R", () => {
    let m = createMonitored(setup("LONG"), t0);
    m = applyPrice(m, 99, t0 + 1).next;
    const closed = closeMonitored(m, 103, t0 + 2);
    expect(closed.final).toBe(true);
    expect(closed.outcomeR).toBeCloseTo(1, 2);
    const cancelled = cancelMonitored(createMonitored(setup("LONG"), t0), t0 + 2);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.outcomeR).toBeNull();
    const s = monitorSummary([closed, cancelled, m]);
    expect(s.finished).toBe(2);
    expect(s.active).toBe(1);
  });
  it("refuses to monitor NO TRADE plans", () => {
    expect(() => createMonitored({ ...setup("LONG"), status: "NO TRADE", direction: null, stopLoss: null, targets: [] }, t0)).toThrow();
  });
});

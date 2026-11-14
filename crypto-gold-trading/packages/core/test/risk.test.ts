import { describe, it, expect } from "vitest";
import { sizePosition, INSTRUMENT_SPECS, riskReward, rMultiple, evaluateCircuitBreaker, evaluateDisciplineGate, portfolioHeat, defaultSpecFor, contractSizeFor, defaultQuantityUnit, instrumentKindFitsAsset } from "../src";

describe("position sizing", () => {
  it("sizes a spot crypto long by risk budget and floors to the lot step", () => {
    const r = sizePosition({ accountBalance: 10000, accountCurrency: "USD", riskPct: 1, direction: "LONG", entry: 65000, stop: 63000, takeProfit: 70000, spec: INSTRUMENT_SPECS["binance-spot-BTCUSDT"] });
    expect(r.status).toBe("SIZED");
    expect(r.riskBudgetAccount).toBe(100);
    expect(r.quantity).toBe(0.05);
    expect(r.potentialLossAccount).toBeCloseTo(100, 6);
    expect(r.potentialProfitAccount).toBeCloseTo(250, 6);
    expect(r.riskReward).toBeCloseTo(2.5, 6);
    expect(r.notionalQuote).toBeCloseTo(3250, 6);
    expect(r.quantity * r.riskPerUnitQuote).toBeLessThanOrEqual(r.riskBudgetQuote + 1e-9);
  });
  it("sizes a perpetual short with leverage, margin estimate and liquidation beyond the stop", () => {
    const r = sizePosition({ accountBalance: 5000, accountCurrency: "USD", riskPct: 2, direction: "SHORT", entry: 3000, stop: 3090, takeProfit: 2800, leverage: 5, spec: INSTRUMENT_SPECS["binance-perp-ETHUSDT"] });
    expect(r.status).toBe("SIZED");
    expect(r.quantity).toBeCloseTo(1.111, 3);
    expect(r.marginEstimateAccount).toBeCloseTo((r.quantity * 3000) / 5, 6);
    expect(r.liquidationEstimate).toBeGreaterThan(3090);
    expect(r.warnings.some((w) => w.includes("liquidation"))).toBe(false);
  });
  it("warns when leverage puts liquidation before the stop", () => {
    const r = sizePosition({ accountBalance: 5000, accountCurrency: "USD", riskPct: 1, direction: "LONG", entry: 60000, stop: 57000, leverage: 50, spec: INSTRUMENT_SPECS["binance-perp-BTCUSDT"] });
    expect(r.status).toBe("SIZED");
    expect(r.liquidationEstimate!).toBeGreaterThan(57000);
    expect(r.warnings.some((w) => w.toLowerCase().includes("liquidation"))).toBe(true);
  });
  it("sizes a gold CFD in lots (100 oz) — $1 move = $100 per lot", () => {
    const r = sizePosition({ accountBalance: 20000, accountCurrency: "USD", riskPct: 1, direction: "LONG", entry: 2650, stop: 2630, takeProfit: 2700, spec: INSTRUMENT_SPECS["xau-cfd-standard"] });
    expect(r.status).toBe("SIZED");
    expect(r.riskPerUnitQuote).toBe(2000);
    expect(r.quantity).toBe(0.1);
    expect(r.baseUnits).toBe(10);
    expect(r.potentialLossAccount).toBeCloseTo(200, 6);
    expect(r.warnings.some((w) => w.includes("broker-specific"))).toBe(true);
  });
  it("sizes COMEX GC contracts with tick-grid validation and never rounds up", () => {
    const ok = sizePosition({ accountBalance: 100000, accountCurrency: "USD", riskPct: 2, direction: "LONG", entry: 2650.0, stop: 2635.0, spec: INSTRUMENT_SPECS["comex-GC"] });
    expect(ok.status).toBe("SIZED");
    expect(ok.riskPerUnitQuote).toBe(1500);
    expect(ok.quantity).toBe(1);
    expect(ok.stopDistanceTicks).toBe(150);
    expect(ok.marginEstimateAccount).toBeNull();
    const offGrid = sizePosition({ accountBalance: 100000, accountCurrency: "USD", riskPct: 2, direction: "LONG", entry: 2650.05, stop: 2635.0, spec: INSTRUMENT_SPECS["comex-GC"] });
    expect(offGrid.status).toBe("INVALID");
    expect(offGrid.reasons[0]).toContain("tick grid");
  });
  it("sizes a silver CFD in lots (5,000 oz) — $0.01 move = $50 per lot", () => {
    const r = sizePosition({ accountBalance: 20000, accountCurrency: "USD", riskPct: 1, direction: "LONG", entry: 48.5, stop: 47.7, takeProfit: 50.5, leverage: 10, spec: INSTRUMENT_SPECS["xag-cfd-standard"] });
    expect(r.status).toBe("SIZED");
    expect(r.riskPerUnitQuote).toBeCloseTo(4000, 6); // 0.80 × 5,000 oz
    expect(r.quantity).toBe(0.05);
    expect(r.baseUnits).toBe(250);
    expect(r.potentialLossAccount).toBeCloseTo(200, 6);
    expect(r.tickValueQuote).toBeCloseTo(5, 9); // $0.001 × 5,000 oz
    expect(r.marginEstimateAccount).toBeCloseTo((0.05 * 5000 * 48.5) / 10, 6);
    expect(r.riskReward).toBeCloseTo(2.5, 6);
    expect(r.warnings.some((w) => w.includes("broker-specific"))).toBe(true);
    const tooMuch = sizePosition({ accountBalance: 20000, accountCurrency: "USD", riskPct: 1, direction: "LONG", entry: 48.5, stop: 47.7, leverage: 20, spec: INSTRUMENT_SPECS["xag-cfd-standard"] });
    expect(tooMuch.warnings.some((w) => w.includes("exceeds the instrument's maximum (10x)"))).toBe(true);
  });
  it("sizes COMEX silver (SI 5,000 oz, SIL 1,000 oz) on the $0.005 tick grid and never rounds up", () => {
    const si = sizePosition({ accountBalance: 100000, accountCurrency: "USD", riskPct: 2, direction: "SHORT", entry: 48.5, stop: 48.85, spec: INSTRUMENT_SPECS["comex-SI"] });
    expect(si.status).toBe("SIZED");
    expect(si.riskPerUnitQuote).toBeCloseTo(1750, 6); // 0.35 × 5,000 oz
    expect(si.quantity).toBe(1); // 2000 / 1750 = 1.14 → 1
    expect(si.stopDistanceTicks).toBe(70);
    expect(si.tickValueQuote).toBeCloseTo(25, 9);
    expect(si.marginEstimateAccount).toBeNull();
    expect(si.marginNote).toContain("NOT computed");
    const micro = sizePosition({ accountBalance: 100000, accountCurrency: "USD", riskPct: 2, direction: "SHORT", entry: 48.5, stop: 48.85, spec: INSTRUMENT_SPECS["comex-SIL"] });
    expect(micro.quantity).toBe(5); // 2000 / 350 = 5.7 → 5
    expect(micro.tickValueQuote).toBeCloseTo(5, 9);
    const offGrid = sizePosition({ accountBalance: 100000, accountCurrency: "USD", riskPct: 2, direction: "SHORT", entry: 48.503, stop: 48.85, spec: INSTRUMENT_SPECS["comex-SI"] });
    expect(offGrid.status).toBe("INVALID");
    expect(offGrid.reasons[0]).toContain("tick grid");
    const tooSmall = sizePosition({ accountBalance: 10000, accountCurrency: "USD", riskPct: 1, direction: "LONG", entry: 48.5, stop: 48, spec: INSTRUMENT_SPECS["comex-SI"] });
    expect(tooSmall.status).toBe("NO_TRADE"); // one contract risks $2,500 against a $100 budget
  });
  it("picks each metal's own instruments and lot size", () => {
    expect(defaultSpecFor("XAUUSD", "cfd").id).toBe("xau-cfd-standard");
    expect(defaultSpecFor("XAGUSD", "cfd").id).toBe("xag-cfd-standard");
    expect(defaultSpecFor("XAGUSD", "spot").id).toBe("xag-cfd-standard"); // spot metal is traded as a CFD, never as a coin
    expect(defaultSpecFor("XAGUSD", "futures").id).toBe("comex-SI");
    expect(contractSizeFor("XAUUSD", "lots")).toBe(100);
    expect(contractSizeFor("XAGUSD", "lots")).toBe(5000);
    expect(contractSizeFor("XAGUSD", "oz")).toBe(1);
    expect(contractSizeFor("BTCUSD", "lots")).toBe(1);
    expect(defaultQuantityUnit("XAGUSD")).toBe("lots");
    expect(defaultQuantityUnit("SOLUSD")).toBe("SOL");
    const kinds = (assetId: string) => Object.values(INSTRUMENT_SPECS).filter((s) => instrumentKindFitsAsset(s.kind, assetId)).map((s) => s.id);
    expect(kinds("XAGUSD")).toEqual(["xag-cfd-standard", "xag-cfd-mini", "comex-SI", "comex-SIL"]);
    expect(kinds("XAUUSD")).toEqual(["xau-cfd-standard", "xau-cfd-mini", "comex-GC", "comex-MGC"]);
    expect(kinds("ETHUSD").every((id) => id.startsWith("binance-") || id.startsWith("cme-"))).toBe(true);
  });
  it("returns NO_TRADE when the risk budget cannot afford one contract", () => {
    const r = sizePosition({ accountBalance: 10000, accountCurrency: "USD", riskPct: 1, direction: "LONG", entry: 2650, stop: 2630, spec: INSTRUMENT_SPECS["comex-GC"] });
    expect(r.status).toBe("NO_TRADE");
    expect(r.quantity).toBe(0);
    expect(r.riskPerUnitQuote).toBe(2000);
    expect(r.reasons[0]).toContain("cannot afford");
  });
  it("sizes CME Bitcoin futures (5 BTC multiplier, $5 tick)", () => {
    const r = sizePosition({ accountBalance: 250000, accountCurrency: "USD", riskPct: 2, direction: "SHORT", entry: 65000, stop: 65500, spec: INSTRUMENT_SPECS["cme-BTC"] });
    expect(r.status).toBe("SIZED");
    expect(r.riskPerUnitQuote).toBe(2500);
    expect(r.quantity).toBe(2);
    expect(r.stopDistanceTicks).toBe(100);
  });
  it("converts to a non-USD account currency", () => {
    // GBP account: 1 USD = 0.78 GBP
    const r = sizePosition({ accountBalance: 7800, accountCurrency: "GBP", riskPct: 1, direction: "LONG", entry: 65000, stop: 63000, takeProfit: 69000, spec: INSTRUMENT_SPECS["binance-spot-BTCUSDT"], fxQuoteToAccount: 0.78 });
    expect(r.status).toBe("SIZED");
    expect(r.riskBudgetAccount).toBe(78);
    expect(r.riskBudgetQuote).toBeCloseTo(100, 6);
    expect(r.quantity).toBe(0.05);
    expect(r.potentialLossAccount).toBeCloseTo(78, 6);
    expect(r.notionalAccount).toBeCloseTo(3250 * 0.78, 6);
  });
  it("rejects invalid geometry and inputs", () => {
    const spec = INSTRUMENT_SPECS["binance-spot-BTCUSDT"];
    expect(sizePosition({ accountBalance: 1000, accountCurrency: "USD", riskPct: 1, direction: "LONG", entry: 100, stop: 110, spec }).status).toBe("INVALID");
    expect(sizePosition({ accountBalance: 1000, accountCurrency: "USD", riskPct: 1, direction: "SHORT", entry: 100, stop: 90, spec }).status).toBe("INVALID");
    expect(sizePosition({ accountBalance: 1000, accountCurrency: "USD", riskPct: 1, direction: "LONG", entry: 100, stop: 90, takeProfit: 95, spec }).status).toBe("INVALID");
    expect(sizePosition({ accountBalance: -5, accountCurrency: "USD", riskPct: 1, direction: "LONG", entry: 100, stop: 90, spec }).status).toBe("INVALID");
    expect(sizePosition({ accountBalance: 1000, accountCurrency: "USD", riskPct: 50, direction: "LONG", entry: 100, stop: 90, spec }).status).toBe("INVALID");
    expect(sizePosition({ accountBalance: 1000, accountCurrency: "USD", riskPct: 1, direction: "LONG", entry: NaN, stop: 90, spec }).status).toBe("INVALID");
    const warn = sizePosition({ accountBalance: 1000, accountCurrency: "USD", riskPct: 3, direction: "LONG", entry: 100, stop: 90, spec });
    expect(warn.warnings.some((w) => w.includes("2%"))).toBe(true);
  });
  it("r multiples and risk/reward are direction aware", () => {
    expect(riskReward(100, 95, 110)).toBe(2);
    expect(rMultiple("LONG", 100, 95, 110)).toBe(2);
    expect(rMultiple("SHORT", 100, 105, 90)).toBe(2);
    expect(rMultiple("LONG", 100, 95, 95)).toBe(-1);
  });
});

describe("discipline gate and circuit breaker", () => {
  const now = Date.UTC(2026, 10, 7, 12);
  it("allows trading with no history and halts on a 2% daily loss", () => {
    expect(evaluateCircuitBreaker([], 10000, now).recommendation).toBe("TRADING_ALLOWED");
    const d = evaluateCircuitBreaker([{ closedAt: now - 3600_000, realizedPnl: -150 }, { closedAt: now - 7200_000, realizedPnl: -60 }], 10000, now);
    expect(d.recommendation).toBe("HALTED");
    expect(d.triggered.map((t) => t.rule)).toContain("max_daily_loss");
  });
  it("applies a cooldown after two consecutive losses", () => {
    const d = evaluateCircuitBreaker([{ closedAt: now - 48 * 3600_000, realizedPnl: 50 }, { closedAt: now - 5 * 3600_000, realizedPnl: -20 }, { closedAt: now - 2 * 3600_000, realizedPnl: -20 }], 100000, now);
    expect(d.recommendation).toBe("COOLDOWN");
    expect(d.metrics.consecutiveLosses).toBe(2);
  });
  it("gate returns GO, NO_GO and REVIEW_REQUIRED appropriately", () => {
    const cb = evaluateCircuitBreaker([], 10000, now);
    const go = evaluateDisciplineGate({ entryInWrittenPlan: true, stopPredefined: true, sizeWithinPlan: true, plannedRiskAmount: 100, actualRiskAmount: 100, recentClosedTrades: [], marketRegime: { zone: "NEUTRAL", direction: "LONG" }, circuitBreaker: cb, now });
    expect(go.decision).toBe("GO");
    const noGo = evaluateDisciplineGate({ entryInWrittenPlan: true, stopPredefined: true, sizeWithinPlan: true, plannedRiskAmount: 100, actualRiskAmount: 150, recentClosedTrades: [], marketRegime: { zone: "NEUTRAL", direction: "LONG" }, circuitBreaker: cb, now });
    expect(noGo.decision).toBe("NO_GO");
    const review = evaluateDisciplineGate({ entryInWrittenPlan: true, stopPredefined: null, sizeWithinPlan: true, plannedRiskAmount: 100, actualRiskAmount: 100, recentClosedTrades: [], marketRegime: { zone: "NEUTRAL", direction: "LONG" }, circuitBreaker: cb, now });
    expect(review.decision).toBe("REVIEW_REQUIRED");
    const revenge = evaluateDisciplineGate({ entryInWrittenPlan: true, stopPredefined: true, sizeWithinPlan: true, plannedRiskAmount: 100, actualRiskAmount: 100, recentClosedTrades: [{ closedAt: now - 3600_000, realizedPnl: -40 }], marketRegime: { zone: "NEUTRAL", direction: "LONG" }, circuitBreaker: cb, now });
    expect(revenge.decision).toBe("NO_GO");
  });
  it("computes portfolio heat", () => {
    expect(portfolioHeat([100, 200], 10000).heatPct).toBe(3);
    expect(portfolioHeat([500, 400], 10000).status).toBe("excessive");
  });
});

import { describe, it, expect } from "vitest";
import { computePerformance, closeTrade, classifyOutcome, filterTrades, tagRelevance, analyzeMultiTimeframe, generateSetups, demoCandles, demoSource, resample, type JournalTrade } from "../src";

function trade(partial: Partial<JournalTrade>): JournalTrade {
  const t0 = Date.UTC(2026, 0, 1);
  return {
    id: Math.random().toString(36).slice(2),
    assetId: "BTCUSD",
    assetClass: "crypto",
    symbol: "BTC/USD",
    direction: "LONG",
    setupType: "trend_pullback",
    timeframe: "4h",
    entry: 100,
    stop: 95,
    takeProfit: 110,
    quantity: 1,
    quantityUnit: "BTC",
    riskPct: 1,
    riskAmount: 5,
    entryReasoning: "",
    screenshots: [],
    exitPrice: null,
    exitAt: null,
    realizedPnl: null,
    rMultiple: null,
    mae: null,
    mfe: null,
    mistakes: "",
    lessons: "",
    status: "open",
    openedAt: t0,
    closedAt: null,
    tags: [],
    source: "manual",
    isTestData: false,
    createdAt: t0,
    updatedAt: t0,
    ...partial,
  };
}

describe("journal performance", () => {
  it("computes win rate, profit factor, expectancy, drawdown and monthly buckets", () => {
    const base = Date.UTC(2026, 0, 5);
    const trades = [
      closeTrade(trade({ openedAt: base }), { exitPrice: 110, exitAt: base + 1 }), // +10, 2R
      closeTrade(trade({ openedAt: base + 10 }), { exitPrice: 95, exitAt: base + 11 }), // -5, -1R
      closeTrade(trade({ openedAt: base + 20, assetClass: "gold", assetId: "XAUUSD", symbol: "XAU/USD", setupType: "breakout" }), { exitPrice: 95, exitAt: Date.UTC(2026, 1, 3) }), // -5
      closeTrade(trade({ openedAt: base + 30, direction: "SHORT", entry: 100, stop: 105 }), { exitPrice: 90, exitAt: Date.UTC(2026, 1, 4) }), // +10
      trade({ openedAt: base + 40 }),
    ];
    const p = computePerformance(trades, { startingBalance: 1000 });
    expect(p.totalTrades).toBe(5);
    expect(p.openTrades).toBe(1);
    expect(p.closedTrades).toBe(4);
    expect(p.winRate).toBe(50);
    expect(p.grossProfit).toBe(20);
    expect(p.grossLoss).toBe(10);
    expect(p.profitFactor).toBe(2);
    expect(p.avgR).toBeCloseTo((2 - 1 - 1 + 2) / 4, 6);
    expect(p.expectancy).toBeCloseTo(0.5 * 10 - 0.5 * 5, 6);
    expect(p.maxDrawdown).toBe(10);
    expect(p.monthly.map((m) => m.month)).toEqual(["2026-01", "2026-02"]);
    expect(p.byClass.gold?.trades).toBe(1);
    expect(p.byClass.crypto?.trades).toBe(3);
    expect(p.byClass.silver).toBeNull(); // no silver trades yet: reported as "none", never as zeros
    expect(p.equityCurve[p.equityCurve.length - 1].equity).toBe(1010);
  });
  it("reports silver as its own class next to crypto and gold, and filters by it", () => {
    const base = Date.UTC(2026, 0, 5);
    const silver = { assetClass: "silver" as const, assetId: "XAGUSD", symbol: "XAG/USD" };
    const trades = [
      closeTrade(trade({ openedAt: base }), { exitPrice: 110, exitAt: base + 1 }),
      closeTrade(trade({ openedAt: base + 10, assetClass: "gold", assetId: "XAUUSD", symbol: "XAU/USD" }), { exitPrice: 95, exitAt: base + 11 }),
      // 0.02 lots of 5,000 oz: +$1.20 per ounce is +$120, 1.5R on an $0.80 stop
      closeTrade(trade({ openedAt: base + 20, ...silver, entry: 48.5, stop: 47.7, quantity: 0.02, quantityUnit: "lots" }), { exitPrice: 49.7, exitAt: base + 21, contractSize: 5000 }),
      closeTrade(trade({ openedAt: base + 30, ...silver, entry: 48.5, stop: 47.7, quantity: 0.02, quantityUnit: "lots" }), { exitPrice: 47.7, exitAt: base + 31, contractSize: 5000 }),
    ];
    const p = computePerformance(trades, { startingBalance: 1000 });
    expect(p.byClass.silver?.trades).toBe(2);
    expect(p.byClass.silver?.totalPnl).toBeCloseTo(120 - 80, 6);
    expect(p.byClass.silver?.winRate).toBe(50);
    expect(p.byClass.gold?.trades).toBe(1);
    expect(p.byClass.crypto?.trades).toBe(1);
    expect(p.byAsset.map((a) => a.key)).toContain("XAG/USD");
    expect(filterTrades(trades, { assetClass: "silver" }).map((t) => t.assetId)).toEqual(["XAGUSD", "XAGUSD"]);
    expect(filterTrades(trades, { assetClass: "gold" }).map((t) => t.assetId)).toEqual(["XAUUSD"]);
  });
  it("excludes test data unless asked", () => {
    const base = Date.UTC(2026, 0, 5);
    const trades = [closeTrade(trade({ openedAt: base, isTestData: true }), { exitPrice: 110, exitAt: base + 1 })];
    expect(computePerformance(trades).closedTrades).toBe(0);
    expect(computePerformance(trades, { includeTestData: true }).closedTrades).toBe(1);
    expect(filterTrades(trades, { includeTestData: false })).toHaveLength(0);
  });
  it("classifies outcomes", () => {
    expect(classifyOutcome("LONG", 100, 103)).toBe("TRUE_POSITIVE");
    expect(classifyOutcome("LONG", 100, 100.2)).toBe("NEUTRAL");
    expect(classifyOutcome("SHORT", 100, 101)).toBe("FALSE_POSITIVE_MILD");
    expect(classifyOutcome("LONG", 100, 95)).toBe("FALSE_POSITIVE_SEVERE");
    expect(classifyOutcome("LONG", 100, 95, "RISK_ON", "RISK_OFF")).toBe("REGIME_MISMATCH");
  });
});

describe("calendar relevance", () => {
  it("tags CPI and FOMC as high-impact for gold and crypto", () => {
    const cpi = tagRelevance("Core CPI m/m", "USD", "medium");
    expect(cpi.importance).toBe("high");
    expect(cpi.relatedMarkets).toEqual(expect.arrayContaining(["gold", "btc"]));
    const fomc = tagRelevance("FOMC Statement", "USD", "high");
    expect(fomc.relatedMarkets).toContain("rates");
    expect(fomc.whyItMatters).toBeTruthy();
    const holiday = tagRelevance("Bank Holiday", "GBP", "holiday");
    expect(holiday.relatedMarkets).toHaveLength(0);
  });
  it("tags silver wherever it tags gold, plus the industrial releases that matter to silver alone", () => {
    for (const title of ["Core CPI m/m", "FOMC Statement", "Non-Farm Employment Change", "Core PCE Price Index m/m", "Advance GDP q/q", "ISM Manufacturing PMI", "Unemployment Rate", "30-y Bond Auction", "Fed Chair Powell Speaks", "Retail Sales m/m"]) {
      const markets = tagRelevance(title, "USD", "medium").relatedMarkets;
      expect(markets, title).toContain("gold");
      expect(markets, title).toContain("silver");
    }
    const factory = tagRelevance("Industrial Production m/m", "USD", "medium");
    expect(factory.relatedMarkets).toContain("silver");
    expect(factory.whyItMatters).toContain("industrial");
    expect(tagRelevance("ISM Manufacturing PMI", "USD", "medium").whyItMatters).toContain("silver");
    // An otherwise untagged US release still affects the dollar, and with it both metals.
    expect(tagRelevance("Some Other Report", "USD", "medium").relatedMarkets).toEqual(["usd", "gold", "silver"]);
    // A release outside the US that is none of the above is tagged for neither metal.
    expect(tagRelevance("Trade Balance", "NZD", "medium").relatedMarkets).toEqual([]);
    expect(tagRelevance("Bitcoin ETF decision", "USD", "low").relatedMarkets).not.toContain("silver");
  });
});

describe("multi-timeframe analysis and setup engine", () => {
  const now = Date.UTC(2026, 10, 7, 12);
  it("produces a consistent MTF result and a well-formed setup on demo data", () => {
    const h1 = demoCandles("BTCUSD", "1h", 1500, now, 7);
    const by = { "1h": h1, "4h": resample(h1, "1h", "4h"), "1d": resample(h1, "1h", "1d") } as const;
    const mtf = analyzeMultiTimeframe("BTCUSD", by, now);
    expect(mtf.perTimeframe.map((p) => p.timeframe)).toEqual(["1h", "4h", "1d"]);
    expect(["bullish", "bearish", "neutral"]).toContain(mtf.overallBias);
    expect(mtf.summary.length).toBeGreaterThan(0);
    const out = generateSetups({ assetId: "BTCUSD", timeframe: "4h", candles: by, mtf, regime: { label: "Crypto regime", zone: "NEUTRAL", bias: "neutral" }, now, dataSource: demoSource("test", now), sizing: { accountBalance: 10000, riskPct: 1 } });
    const s = out.primary;
    expect(s.assetId).toBe("BTCUSD");
    expect(s.timeframe).toBe("4h");
    expect(["STRONG LONG", "LONG", "WAIT FOR CONFIRMATION", "NEUTRAL", "SHORT", "STRONG SHORT", "NO TRADE"]).toContain(s.status);
    if (s.status !== "NO TRADE") {
      expect(s.stopLoss).not.toBeNull();
      expect(s.targets).toHaveLength(3);
      if (s.direction === "LONG") {
        expect(s.stopLoss!).toBeLessThan(s.entry.low);
        expect(s.targets[0].price).toBeGreaterThan(s.entry.mid);
        expect(s.targets[1].price).toBeGreaterThan(s.targets[0].price);
        expect(s.targets[2].price).toBeGreaterThan(s.targets[1].price);
      } else {
        expect(s.stopLoss!).toBeGreaterThan(s.entry.high);
        expect(s.targets[0].price).toBeLessThan(s.entry.mid);
        expect(s.targets[1].price).toBeLessThan(s.targets[0].price);
        expect(s.targets[2].price).toBeLessThan(s.targets[1].price);
      }
      expect(s.riskRewardTp1!).toBeGreaterThanOrEqual(1);
      expect(s.qualityScore).toBeGreaterThanOrEqual(0);
      expect(s.qualityScore).toBeLessThanOrEqual(100);
      expect(s.rationale.length).toBeGreaterThan(2);
    } else {
      expect(s.rationale.length).toBeGreaterThan(0);
    }
    expect(out.levels.length).toBeGreaterThan(5);
  });
  it("returns NO TRADE on stale data", () => {
    const stale = demoCandles("XAUUSD", "1h", 600, now - 48 * 3600_000, 3);
    const by = { "1h": stale, "4h": resample(stale, "1h", "4h") } as const;
    const mtf = analyzeMultiTimeframe("XAUUSD", by, now);
    const out = generateSetups({ assetId: "XAUUSD", timeframe: "1h", candles: by, mtf, regime: null, now, dataSource: demoSource("test", now) });
    expect(out.primary.status).toBe("NO TRADE");
    expect(out.primary.rationale[0]).toMatch(/stale/i);
  });
  it("scans several seeds without throwing and keeps TP ordering", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const h1 = demoCandles("ETHUSD", "1h", 1200, now, seed);
      const by = { "15m": demoCandles("ETHUSD", "15m", 800, now, seed), "1h": h1, "4h": resample(h1, "1h", "4h"), "1d": resample(h1, "1h", "1d") } as const;
      const mtf = analyzeMultiTimeframe("ETHUSD", by, now);
      for (const tf of ["15m", "1h", "4h"] as const) {
        const out = generateSetups({ assetId: "ETHUSD", timeframe: tf, candles: by, mtf, regime: null, now, dataSource: demoSource("t", now) });
        for (const s of [out.primary, ...out.alternatives]) {
          if (s.status === "NO TRADE" || !s.direction) continue;
          const rs = s.targets.map((t) => t.rMultiple);
          expect(rs[0]).toBeLessThan(rs[1]);
          expect(rs[1]).toBeLessThan(rs[2]);
        }
      }
    }
  });
});

describe("setup stop sanity", () => {
  const now = Date.UTC(2026, 10, 7, 12);
  it("keeps stops outside the entry zone and between 0.6 and 3.2 ATR of the entry on every seed", () => {
    for (const asset of ["BTCUSD", "XAUUSD", "SOLUSD"] as const) {
      for (let seed = 1; seed <= 15; seed++) {
        const h1 = demoCandles(asset, "1h", 1200, now, seed);
        const by = { "15m": demoCandles(asset, "15m", 800, now, seed), "1h": h1, "4h": resample(h1, "1h", "4h"), "1d": resample(h1, "1h", "1d") } as const;
        const mtf = analyzeMultiTimeframe(asset, by, now);
        for (const tf of ["15m", "1h", "4h"] as const) {
          const out = generateSetups({ assetId: asset, timeframe: tf, candles: by, mtf, regime: null, now, dataSource: demoSource("t", now) });
          const exec = mtf.perTimeframe.find((p) => p.timeframe === tf)!;
          const atr = exec.indicators.atr14;
          for (const s of [out.primary, ...out.alternatives]) {
            if (!s.direction || s.stopLoss === null) continue;
            const dist = Math.abs(s.entry.mid - s.stopLoss) / atr;
            if (s.direction === "LONG") expect(s.stopLoss).toBeLessThan(s.entry.low);
            else expect(s.stopLoss).toBeGreaterThan(s.entry.high);
            if (s.status !== "NO TRADE") {
              expect(dist).toBeGreaterThanOrEqual(0.55);
              expect(dist).toBeLessThanOrEqual(3.3);
            }
          }
        }
      }
    }
  });
  it("tags NFP correctly but not productivity releases, and only Fed speakers", () => {
    expect(tagRelevance("Non-Farm Employment Change", "USD", "high").relatedMarkets).toContain("btc");
    expect(tagRelevance("Prelim Nonfarm Productivity q/q", "USD", "medium").relatedMarkets).not.toContain("btc");
    expect(tagRelevance("BOE Gov Bailey Speaks", "GBP", "high").relatedMarkets).not.toContain("gold");
    expect(tagRelevance("FOMC Member Hammack Speaks", "USD", "high").relatedMarkets).toContain("rates");
  });
});

describe("dynamic asset universe", () => {
  it("validates canonical ids and resolves metadata for non-core coins", async () => {
    const { isAssetId, isCoreAsset, resolveAsset, precisionForPrice, roundStepForPrice, assetBase } = await import("../src");
    expect(isAssetId("POLUSD")).toBe(true);
    expect(isAssetId("ENAUSD")).toBe(true);
    expect(isAssetId("btcusd")).toBe(false);
    expect(isAssetId("POL")).toBe(false);
    expect(isCoreAsset("BTCUSD")).toBe(true);
    expect(isCoreAsset("POLUSD")).toBe(false);
    expect(assetBase("XAUUSD")).toBe("XAU");
    expect(assetBase("XAGUSD")).toBe("XAG");
    const pol = resolveAsset("POLUSD", { price: 0.1734, name: "POL (ex-MATIC)" });
    expect(pol.symbol).toBe("POL/USD");
    expect(pol.name).toBe("POL (ex-MATIC)");
    expect(pol.pricePrecision).toBe(5);
    expect(pol.roundStep).toBeCloseTo(0.01, 10);
    expect(pol.assetClass).toBe("crypto");
    expect(resolveAsset("BTCUSD").pricePrecision).toBe(1);
    expect(precisionForPrice(2241)).toBe(1);
    expect(precisionForPrice(0.00001234)).toBe(8);
    expect(roundStepForPrice(76000)).toBe(1000);
    expect(roundStepForPrice(89)).toBe(10);
  });
  it("generates setups for a non-core asset on demo data without throwing", () => {
    const now = Date.UTC(2026, 10, 7, 12);
    const h1 = demoCandles("POLUSD", "1h", 1200, now, 5);
    const by = { "1h": h1, "4h": resample(h1, "1h", "4h"), "1d": resample(h1, "1h", "1d") } as const;
    const mtf = analyzeMultiTimeframe("POLUSD", by, now);
    const out = generateSetups({ assetId: "POLUSD", timeframe: "4h", candles: by, mtf, regime: null, now, dataSource: demoSource("t", now) });
    expect(out.primary.symbol).toBe("POL/USD");
    expect(out.primary.assetId).toBe("POLUSD");
  });
});

describe("setup transparency and gating", () => {
  const now = Date.UTC(2026, 10, 7, 12);
  it("every setup carries contributions, MTF confirmation, sufficiency and data status; actionable ones pass both gates", () => {
    let actionable = 0;
    for (const asset of ["BTCUSD", "ETHUSD", "XAUUSD"] as const) {
      for (let seed = 1; seed <= 10; seed++) {
        const h1 = demoCandles(asset, "1h", 1200, now, seed);
        const by = { "15m": demoCandles(asset, "15m", 800, now, seed), "1h": h1, "4h": resample(h1, "1h", "4h"), "1d": resample(h1, "1h", "1d") } as const;
        const mtf = analyzeMultiTimeframe(asset, by, now);
        for (const tf of ["1h", "4h"] as const) {
          const out = generateSetups({ assetId: asset, timeframe: tf, candles: by, mtf, regime: null, now, dataSource: demoSource("t", now) });
          const s = out.primary;
          expect(s.contributions!.length).toBeGreaterThan(5);
          expect(s.mtfConfirmation!.length).toBe(4);
          expect(s.dataStatus!.length).toBe(4);
          expect(s.sufficiency).toBeDefined();
          if (["STRONG LONG", "LONG", "SHORT", "STRONG SHORT"].includes(s.status)) {
            actionable++;
            expect(s.sufficiency!.sufficient).toBe(true);
            expect(s.mtfConfirmed).toBe(true);
            expect(s.keyLevels).not.toBeNull();
            expect(s.entryBasis).toBeTruthy();
            expect(s.stopBasis).toBeTruthy();
            // contributions supporting the direction must outweigh opposing ones
            const net = s.contributions!.reduce((a, c) => a + c.weight, 0);
            expect(net).toBeGreaterThan(0);
          }
          if (s.status === "NO TRADE") expect(s.sufficiency!.sufficient).toBe(false);
        }
      }
    }
    expect(actionable).toBeGreaterThan(0);
  });
});

describe("data blockers", () => {
  const now = Date.UTC(2026, 10, 7, 12);
  it("returns NO TRADE with the stated reason whenever the input data is flagged as unusable", () => {
    for (const asset of ["BTCUSD", "XAUUSD"] as const) {
      for (let seed = 1; seed <= 6; seed++) {
        const h1 = demoCandles(asset, "1h", 1200, now, seed);
        const by = { "15m": demoCandles(asset, "15m", 800, now, seed), "1h": h1, "4h": resample(h1, "1h", "4h"), "1d": resample(h1, "1h", "1d") } as const;
        const mtf = analyzeMultiTimeframe(asset, by, now);
        const reason = "Price history on 1h, 4h still has gaps. No setup is generated on incomplete data.";
        const blocked = generateSetups({ assetId: asset, timeframe: "4h", candles: by, mtf, regime: null, now, dataSource: demoSource("t", now), dataBlockers: [reason] }).primary;
        expect(blocked.status).toBe("NO TRADE");
        expect(blocked.direction).toBeNull();
        expect(blocked.rationale).toEqual([reason]);
        expect(blocked.sufficiency?.sufficient).toBe(false);
        expect(blocked.opposing.some((e) => e.category === "data")).toBe(true);
        // An empty list changes nothing.
        const free = generateSetups({ assetId: asset, timeframe: "4h", candles: by, mtf, regime: null, now, dataSource: demoSource("t", now), dataBlockers: [] }).primary;
        const plain = generateSetups({ assetId: asset, timeframe: "4h", candles: by, mtf, regime: null, now, dataSource: demoSource("t", now) }).primary;
        expect(free.status).toBe(plain.status);
        expect(free.id).toBe(plain.id);
      }
    }
  });
});

describe("precious metals", () => {
  it("describes gold and silver as session-based spot metals, each with its own lot size", async () => {
    const { ASSETS, CRYPTO_ASSETS, METALS, METAL_ASSETS, isMetalAsset, isMetalClass, metalAssetId, metalInfo, resolveAsset, isCoreAsset } = await import("../src");
    expect(METAL_ASSETS).toEqual(["XAUUSD", "XAGUSD"]);
    expect(isCoreAsset("XAGUSD")).toBe(true);
    expect(resolveAsset("XAGUSD")).toMatchObject({ symbol: "XAG/USD", name: "Silver (spot)", assetClass: "silver", base: "XAG", continuous: false, pricePrecision: 3, roundStep: 1 });
    expect(resolveAsset("XAUUSD")).toMatchObject({ symbol: "XAU/USD", assetClass: "gold", continuous: false, pricePrecision: 2, roundStep: 50 });
    expect(CRYPTO_ASSETS.some(isMetalAsset)).toBe(false);
    expect(Object.keys(ASSETS).filter(isMetalAsset)).toEqual(["XAUUSD", "XAGUSD"]);
    // The tokenised stand-ins are ordinary crypto assets, never the metal itself.
    expect(isMetalAsset("PAXGUSD")).toBe(false);
    expect(resolveAsset("PAXGUSD").assetClass).toBe("crypto");
    expect(isMetalClass("silver")).toBe(true);
    expect(isMetalClass("crypto")).toBe(false);
    expect(metalAssetId("silver")).toBe("XAGUSD");
    expect(metalInfo("silver")).toEqual(METALS.XAGUSD);
    expect(metalInfo("XAUUSD")).toMatchObject({ metal: "gold", title: "Gold", code: "XAU", pair: "XAU/USD", standardLotOz: 100 });
    expect(METALS.XAGUSD).toMatchObject({ metal: "silver", title: "Silver", code: "XAG", pair: "XAG/USD", standardLotOz: 5000 });
  });
  it("plans a silver trade like a gold one: sized in CFD lots, round numbers at whole dollars, session gaps tolerated", () => {
    const now = Date.UTC(2026, 10, 11, 12);
    const h1 = demoCandles("XAGUSD", "1h", 1200, now, 5);
    const by = { "1h": h1, "4h": resample(h1, "1h", "4h"), "1d": resample(h1, "1h", "1d") } as const;
    const mtf = analyzeMultiTimeframe("XAGUSD", by, now);
    const out = generateSetups({ assetId: "XAGUSD", timeframe: "4h", candles: by, mtf, regime: { label: "Silver posture", zone: "MIXED", bias: "neutral" }, now, dataSource: demoSource("t", now), sizing: { accountBalance: 50000, riskPct: 1 } });
    const s = out.primary;
    expect(s.symbol).toBe("XAG/USD");
    expect(s.status).toBe("LONG");
    expect(s.regime).toContain("Silver posture");
    expect(s.sizingPreview?.quantityUnit).toBe("lots");
    // 0.27 standard lots of 5,000 oz: the risk is the stop distance times 1,350 oz, inside the 1 % budget.
    expect(s.sizingPreview?.quantity).toBe(0.27);
    // (entry and stop are shown rounded to three decimals: up to $0.001 × 1,350 oz of rounding)
    expect(Math.abs(s.sizingPreview!.riskAmount - Math.abs(s.entry.mid - s.stopLoss!) * 0.27 * 5000)).toBeLessThan(1.35);
    expect(s.sizingPreview!.riskAmount).toBeLessThanOrEqual(500);
    expect(s.sizingPreview!.riskAmount).toBeGreaterThan(480); // the next 0.01 lot would exceed the budget
    const round = out.levels.filter((l) => l.kind === "round_number").map((l) => l.price);
    expect(round).toEqual([43, 44, 45, 46, 47, 48, 49]);
  });
  it("gives silver its own demo series: around its own price, calmer than a coin, livelier than gold", () => {
    const now = Date.UTC(2026, 10, 11, 12);
    const range = (assetId: string) => {
      const c = demoCandles(assetId, "1h", 500, now);
      return { last: c[c.length - 1].close, avgBarPct: (c.reduce((a, x) => a + (x.high - x.low) / x.close, 0) / c.length) * 100 };
    };
    const silver = range("XAGUSD");
    expect(silver.last).toBeGreaterThan(10);
    expect(silver.last).toBeLessThan(100);
    expect(silver.avgBarPct).toBeGreaterThan(range("XAUUSD").avgBarPct);
    expect(silver.avgBarPct).toBeLessThan(range("BTCUSD").avgBarPct);
  });
});

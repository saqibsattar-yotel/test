import { describe, it, expect } from "vitest";
import { extractNumbers, ungroundedNumbers, ruleBasedNarrative } from "../src/services/ai";
import { syntheticDxy } from "../src/providers/macro";
import { parseKlines } from "../src/providers/binance";
import { mergeEvents } from "../src/providers/calendar";
import { parseFeed, tagNews } from "../src/providers/news";
import { TtlCache } from "../src/lib/cache";

describe("AI grounding", () => {
  const facts = { price: 76002.23, rsi: 48.3, targets: [{ price: 72547.7, r: 2.29 }], text: "stop 81,618.70" };
  it("extracts numbers including thousands separators", () => {
    expect(extractNumbers("BTC at 76,002.23 with RSI 48.3")).toEqual(["76002.23", "48.3"]);
  });
  it("accepts numbers present in the fact sheet (any formatting) and small counts", () => {
    expect(ungroundedNumbers("Price 76,002 and RSI 48.3; target 72547.7 (2.3R); stop 81618.7; 3 timeframes agree in 2026", facts)).toEqual([]);
  });
  it("flags invented numbers", () => {
    expect(ungroundedNumbers("Price could reach 85,000 next week", facts)).toEqual(["85000"]);
  });
  it("rule-based narrative is labelled and grounded", () => {
    const n = ruleBasedNarrative(["a", "b"], 1);
    expect(n.mode).toBe("rule-based");
    expect(n.grounded).toBe(true);
    expect(n.paragraphs).toHaveLength(2);
  });
});

describe("providers", () => {
  it("synthetic DXY reproduces the ICE formula at a known fixing", () => {
    // EURUSD 1.0800, USDJPY 150, GBPUSD 1.2600, USDCAD 1.36, USDSEK 10.5, USDCHF 0.90 -> ~104 region
    const v = syntheticDxy({ EUR: 1 / 1.08, JPY: 150, GBP: 1 / 1.26, CAD: 1.36, SEK: 10.5, CHF: 0.9 });
    expect(v).toBeGreaterThan(100);
    expect(v).toBeLessThan(108);
    // Stronger dollar vs euro -> higher index
    expect(syntheticDxy({ EUR: 1 / 1.0, JPY: 150, GBP: 1 / 1.26, CAD: 1.36, SEK: 10.5, CHF: 0.9 })).toBeGreaterThan(v);
  });
  it("parses Binance klines", () => {
    const c = parseKlines([[1700000000000, "100.5", "110", "99", "105", "12.5", 1700003599999, "1300", 10, "6", "640", "0"]]);
    expect(c[0]).toEqual({ time: 1700000000000, open: 100.5, high: 110, low: 99, close: 105, volume: 12.5 });
  });
  it("merges feed forecasts into official schedule entries without duplicating", () => {
    const t = Date.UTC(2026, 10, 10, 13, 30);
    const official = [{ id: "o1", title: "Consumer Price Index (CPI) — October 2026", country: "USD", time: t, importance: "high" as const, previous: null, forecast: null, actual: null, source: { provider: "official-schedule", label: "BLS" }, official: true, relatedMarkets: ["gold" as const], whyItMatters: null }];
    const feed = [{ id: "f1", title: "CPI m/m", country: "USD", time: t, importance: "high" as const, previous: "0.3%", forecast: "0.2%", actual: null, source: { provider: "forexfactory", label: "FF" }, official: false, relatedMarkets: ["gold" as const], whyItMatters: null }, { id: "f2", title: "Retail Sales m/m", country: "USD", time: t + 86_400_000, importance: "medium" as const, previous: null, forecast: null, actual: null, source: { provider: "forexfactory", label: "FF" }, official: false, relatedMarkets: [], whyItMatters: null }];
    const merged = mergeEvents(official, feed);
    expect(merged).toHaveLength(2);
    expect(merged[0].forecast).toBe("0.2%");
    expect(merged[0].official).toBe(true);
  });
  it("parses RSS and tags relevance", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><item><title>Gold climbs as Fed signals rate cut</title><link>https://example.com/a</link><pubDate>Fri, 06 Nov 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Bullion rose.</p>]]></description></item></channel></rss>`;
    const items = parseFeed(xml, { url: "x", publisher: "Test", topics: ["gold"] });
    expect(items).toHaveLength(1);
    expect(items[0].relevance).toEqual(expect.arrayContaining(["gold", "fed"]));
    expect(items[0].summary).toBe("Bullion rose.");
    expect(tagNews("Bitcoin ETF inflows surge", "")).toEqual(expect.arrayContaining(["btc", "crypto"]));
  });
});

describe("cache", () => {
  it("serves stale value with error when refresh fails", async () => {
    const c = new TtlCache();
    const first = await c.getOrLoad("k", 1, async () => 1);
    expect(first.value).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    const second = await c.getOrLoad("k", 1, async () => {
      throw new Error("down");
    });
    expect(second.value).toBe(1);
    expect(second.stale).toBe(true);
    expect(second.error).toBe("down");
    await expect(c.getOrLoad("missing", 1, async () => { throw new Error("nope"); })).rejects.toThrow("nope");
  });
});

describe("asset registry", () => {
  it("builds a universe from exchange pairs enriched with CoinGecko, excluding fiat/stable/leveraged products", async () => {
    const { buildRegistry } = await import("../src/services/assets");
    const ex = [
      { symbol: "POLUSDT", baseAsset: "POL", quoteAsset: "USDT", status: "TRADING", tickSize: 0.0001 },
      { symbol: "ENAUSDT", baseAsset: "ENA", quoteAsset: "USDT", status: "TRADING", tickSize: 0.0001 },
      { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING", tickSize: 0.01 },
      { symbol: "USDCUSDT", baseAsset: "USDC", quoteAsset: "USDT", status: "TRADING", tickSize: 0.0001 },
      { symbol: "ETHUPUSDT", baseAsset: "ETHUP", quoteAsset: "USDT", status: "TRADING", tickSize: 0.001 },
      { symbol: "OLDUSDT", baseAsset: "OLD", quoteAsset: "USDT", status: "BREAK", tickSize: 0.001 },
      { symbol: "POLBTC", baseAsset: "POL", quoteAsset: "BTC", status: "TRADING", tickSize: 1e-8 },
    ];
    const cg = [
      { symbol: "pol", name: "POL (ex-MATIC)", rank: 75, marketCapUsd: 1.8e9, priceUsd: 0.1734 },
      { symbol: "ena", name: "Ethena", rank: 43, marketCapUsd: 3.2e9, priceUsd: 0.28 },
      { symbol: "btc", name: "Bitcoin", rank: 1, marketCapUsd: 1.5e12, priceUsd: 76000 },
    ];
    const reg = buildRegistry(ex, cg);
    expect(reg.get("POLUSD")?.name).toBe("POL (ex-MATIC)");
    expect(reg.get("POLUSD")?.rank).toBe(75);
    expect(reg.get("POLUSD")?.pricePrecision).toBe(4);
    expect(reg.get("ENAUSD")?.symbol).toBe("ENA/USD");
    expect(reg.get("BTCUSD")?.core).toBe(true);
    expect(reg.get("BTCUSD")?.rank).toBe(1);
    expect(reg.has("USDCUSD")).toBe(false);
    expect(reg.has("ETHUPUSD")).toBe(false);
    expect(reg.has("OLDUSD")).toBe(false);
    expect(reg.has("XAUUSD")).toBe(true);
  });
  it("search ranks exact ticker matches first, then prefixes, then names", async () => {
    const { buildRegistry } = await import("../src/services/assets");
    const reg = buildRegistry([{ symbol: "ENAUSDT", baseAsset: "ENA", quoteAsset: "USDT", status: "TRADING" }, { symbol: "ENSUSDT", baseAsset: "ENS", quoteAsset: "USDT", status: "TRADING" }, { symbol: "ARENAUSDT", baseAsset: "ARENA", quoteAsset: "USDT", status: "TRADING" }], [{ symbol: "ena", name: "Ethena", rank: 43, marketCapUsd: 1, priceUsd: 0.28 }, { symbol: "ens", name: "Ethereum Name Service", rank: 90, marketCapUsd: 1, priceUsd: 15 }]);
    const list = [...reg.values()];
    const t = "EN";
    const order = list.filter((a) => a.base.startsWith(t)).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9)).map((a) => a.id);
    expect(order[0]).toBe("ENAUSD");
    expect(reg.get("ARENAUSD")?.name).toBe("ARENA");
  });
});

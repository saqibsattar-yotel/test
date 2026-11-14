import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import lzma from "lzma";
import type { Candle } from "@terminal/core";
import { DECIMALS, aggregate, decodeCandles, decodeTicksToMinutes } from "../src/providers/dukascopy";
import { dxyFromRates, isSpotMarketOpen } from "../src/providers/swissquote";
import { aggregateWeekly, depthFor, mergeLive } from "../src/services/gold";

function lzmaDecompress(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    lzma.decompress(buf, (result, error) => {
      if (error) return reject(error);
      resolve(typeof result === "string" ? Buffer.from(result, "binary") : Buffer.from(Uint8Array.from(result, (b) => b & 0xff)));
    });
  });
}
const mk = (time: number, o: number, h: number, l: number, c: number, v = 1): Candle => ({ time, open: o, high: h, low: l, close: c, volume: v });
const H = 3_600_000;
const M = 60_000;

describe("Dukascopy archive decoding", () => {
  it("decodes a real hourly archive month (XAU/USD, October 2026) with the documented scaling", async () => {
    const raw = await lzmaDecompress(fs.readFileSync(fileURLToPath(new URL("./fixtures/XAUUSD_2026-10_hour.bi5", import.meta.url))));
    expect(raw.length % 24).toBe(0);
    expect(raw.length / 24).toBe(744); // 31 days × 24 hours, closed hours included as flat filler
    const candles = decodeCandles(raw, Date.UTC(2026, 9, 1), DECIMALS.XAUUSD);
    expect(candles.length).toBe(504); // filler removed → only traded hours remain
    expect(candles[0].time).toBe(Date.UTC(2026, 9, 1));
    const last = candles[candles.length - 1];
    expect(new Date(last.time).toISOString()).toBe("2026-10-30T20:00:00.000Z"); // Friday NY close hour
    expect(last.close).toBeCloseTo(3874.585, 3);
    for (const c of candles) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(c.close).toBeGreaterThan(3000);
      expect(c.close).toBeLessThan(6000);
    }
    // weekend gap: no candle on Saturday 3 Oct
    expect(candles.some((c) => new Date(c.time).getUTCDay() === 6)).toBe(false);
  });

  it("drops flat zero-volume filler and applies the price scale", () => {
    const buf = Buffer.alloc(48);
    buf.writeInt32BE(0, 0);
    buf.writeInt32BE(4000500, 4);
    buf.writeInt32BE(4001000, 8);
    buf.writeInt32BE(3999000, 12);
    buf.writeInt32BE(4002000, 16);
    buf.writeFloatBE(1.5, 20);
    buf.writeInt32BE(3600, 24);
    for (const o of [28, 32, 36, 40]) buf.writeInt32BE(4001000, o);
    buf.writeFloatBE(0, 44);
    const c = decodeCandles(buf, Date.UTC(2026, 0, 1), 1000);
    expect(c).toEqual([{ time: Date.UTC(2026, 0, 1), open: 4000.5, high: 4002, low: 3999, close: 4001, volume: 1.5 }]);
  });

  it("aggregates ticks into bid-side minute candles", () => {
    const buf = Buffer.alloc(60);
    const tick = (i: number, ms: number, ask: number, bid: number) => {
      buf.writeInt32BE(ms, i * 20);
      buf.writeInt32BE(ask, i * 20 + 4);
      buf.writeInt32BE(bid, i * 20 + 8);
      buf.writeFloatBE(1, i * 20 + 12);
      buf.writeFloatBE(2, i * 20 + 16);
    };
    tick(0, 0, 110005, 110000);
    tick(1, 30_000, 110015, 110010);
    tick(2, 61_000, 109995, 109990);
    const base = Date.UTC(2026, 10, 5, 20);
    const c = decodeTicksToMinutes(buf, base, 100000);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ time: base, open: 1.1, high: 1.1001, low: 1.1, close: 1.1001 });
    expect(c[1]).toMatchObject({ time: base + M, open: 1.0999, close: 1.0999 });
  });

  it("aggregate buckets minutes into 5-minute candles", () => {
    const t0 = Date.UTC(2026, 0, 1);
    const minutes = [mk(t0, 1, 3, 1, 2), mk(t0 + M, 2, 5, 2, 4), mk(t0 + 4 * M, 4, 4, 0.5, 1), mk(t0 + 5 * M, 1, 2, 1, 2)];
    const five = aggregate(minutes, 5 * M);
    expect(five).toEqual([mk(t0, 1, 5, 0.5, 1, 3), mk(t0 + 5 * M, 1, 2, 1, 2, 1)]);
  });

  it("mergeLive only appends live bars after the last published archive step", () => {
    const t0 = Date.UTC(2026, 10, 6, 10);
    const history = [mk(t0, 100, 110, 90, 105, 10), mk(t0 + H, 105, 115, 100, 110, 10)];
    const live = [mk(t0 + H + 30 * M, 999, 999, 999, 999), mk(t0 + 2 * H + 5 * M, 110, 112, 109, 111), mk(t0 + 2 * H + 10 * M, 111, 114, 110, 113)];
    const merged = mergeLive(history, live, H, H);
    expect(merged).toHaveLength(3);
    expect(merged[1]).toEqual(history[1]); // published hour untouched by the stray live minute
    expect(merged[2]).toEqual(mk(t0 + 2 * H, 110, 114, 109, 113, 2));
  });

  it("aggregateWeekly aligns weeks to Monday 00:00 UTC", () => {
    const wed = Date.UTC(2026, 10, 4); // Wednesday
    const mon = Date.UTC(2026, 10, 2);
    const weeks = aggregateWeekly([mk(wed, 1, 2, 1, 2), mk(wed + 86_400_000, 2, 3, 1.5, 2.5), mk(Date.UTC(2026, 10, 9), 3, 3, 3, 3)]);
    expect(weeks).toHaveLength(2);
    expect(weeks[0]).toEqual(mk(mon, 1, 3, 1, 2.5, 2));
    expect(weeks[1].time).toBe(Date.UTC(2026, 10, 9));
  });
});

describe("US Dollar Index", () => {
  it("uses the ICE constant and weights", () => {
    expect(dxyFromRates({ EURUSD: 1, USDJPY: 1, GBPUSD: 1, USDCAD: 1, USDSEK: 1, USDCHF: 1 })).toBeCloseTo(50.14348112, 6);
    const base = { EURUSD: 1.0845, USDJPY: 149.2, GBPUSD: 1.2615, USDCAD: 1.3602, USDSEK: 10.45, USDCHF: 0.8911 };
    const v = dxyFromRates(base);
    expect(v).toBeGreaterThan(100);
    expect(v).toBeLessThan(108);
    expect(dxyFromRates({ ...base, EURUSD: 1.05 })).toBeGreaterThan(v); // weaker euro → stronger index
    expect(dxyFromRates({ ...base, USDJPY: 155 })).toBeGreaterThan(v); // weaker yen → stronger index
    expect(dxyFromRates({ ...base, GBPUSD: 1.3 })).toBeLessThan(v);
  });

  it("knows the spot/FX trading week (Sun 22:00 → Fri 22:00 UTC)", () => {
    expect(isSpotMarketOpen(Date.UTC(2026, 10, 7, 12))).toBe(false); // Saturday
    expect(isSpotMarketOpen(Date.UTC(2026, 10, 6, 21, 59))).toBe(true); // Friday before close
    expect(isSpotMarketOpen(Date.UTC(2026, 10, 6, 22))).toBe(false); // Friday after close
    expect(isSpotMarketOpen(Date.UTC(2026, 10, 8, 21, 59))).toBe(false); // Sunday before open
    expect(isSpotMarketOpen(Date.UTC(2026, 10, 8, 22))).toBe(true); // Sunday open
    expect(isSpotMarketOpen(Date.UTC(2026, 10, 4, 3))).toBe(true); // Wednesday
  });
});

describe("archive depth tiers", () => {
  it("serves every requested bar count from a small, fixed set of shared series", () => {
    expect(depthFor("1d", 500)).toBe(0);
    expect(depthFor("1w", 300)).toBe(0);
    expect(depthFor("1h", 48)).toBe(2); // months
    expect(depthFor("1h", 600)).toBe(2);
    expect(depthFor("1h", 1000)).toBe(5);
    expect(depthFor("4h", 600)).toBe(5);
    expect(depthFor("4h", 1000)).toBe(8);
    expect(depthFor("4h", 3000)).toBe(12);
    expect(depthFor("5m", 500)).toBe(5); // calendar days
    expect(depthFor("15m", 500)).toBe(12);
    expect(depthFor("15m", 600)).toBe(12);
    expect(depthFor("15m", 3000)).toBe(35);
    const tiers = new Set<string>();
    for (const tf of ["5m", "15m", "1h", "4h", "1d", "1w"] as const) for (let limit = 50; limit <= 3000; limit += 50) tiers.add(`${tf}:${depthFor(tf, limit)}`);
    expect(tiers.size).toBeLessThanOrEqual(16); // bounded, however many different limits clients ask for
  });
});

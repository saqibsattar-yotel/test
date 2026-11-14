/**
 * When the archive keeps refusing some files, history has gaps. A gappy gold or silver series is held back
 * for a few minutes while the files are retried; after that it is served clearly flagged, with setups
 * withheld. The close-based dollar index never uses a gappy history at all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Candle } from "@terminal/core";

const archive = vi.hoisted(() => ({ goldMissing: 2, silverMissing: 1, fxMissing: 3 }));

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
function series(from: number, to: number, step: number, base: number): Candle[] {
  const out: Candle[] = [];
  for (let t = Math.floor(from / step) * step, i = 0; t < to; t += step, i++) {
    if (new Date(t).getUTCDay() === 6) continue;
    const close = base + Math.sin(i / 7) * 5 + i * 0.01;
    out.push({ time: t, open: close - 0.4, high: close + 1, low: close - 1, close, volume: 10 });
  }
  return out;
}

vi.mock("../src/providers/dukascopy", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/providers/dukascopy")>();
  const base = (instrument: string) => (instrument === "XAUUSD" ? 4000 : instrument === "XAGUSD" ? 48 : instrument === "USDJPY" ? 150 : instrument === "USDSEK" ? 9.5 : 1.1);
  const build = async (instrument: string, candles: Candle[]) => ({ candles, missing: instrument === "XAUUSD" ? archive.goldMissing : instrument === "XAGUSD" ? archive.silverMissing : archive.fxMissing });
  return {
    ...real,
    dukascopy: {
      stats: { downloaded: 0, failedAttempts: 0 },
      progress: () => ({ gold: { total: 32, done: 30, failing: archive.goldMissing }, silver: { total: 32, done: 31, failing: archive.silverMissing }, other: { total: 60, done: 57, failing: archive.fxMissing }, active: 0, queued: 0, state: "paused", resumesAt: Date.now() + 60_000, nextRetryAt: Date.now() + 30_000 }),
      minuteSeries: (instrument: string, from: number, now: number) => build(instrument, series(from, now, MIN, base(instrument))),
      hourlySeries: (instrument: string, months: number, now: number) => build(instrument, series(now - months * 30 * DAY, now, HOUR, base(instrument))),
      dailySeries: (instrument: string, years: number, now: number) => build(instrument, series(now - years * 365 * DAY, now, DAY, base(instrument))),
      recentDailySeries: (instrument: string, months: number, now: number) => build(instrument, series(now - months * 30 * DAY, now, DAY, base(instrument))),
    },
  };
});

vi.mock("../src/providers/swissquote", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/providers/swissquote")>();
  return {
    ...real,
    getSwissquoteQuote: async (instrument: string) => (instrument === "XAG/USD" ? { instrument, bid: 48.6, ask: 48.66, mid: 48.63, spread: 0.06, ts: Date.now() } : { instrument, bid: 4010, ask: 4011, mid: 4010.5, spread: 1, ts: Date.now() }),
    getLiveDxyFromSwissquote: async () => ({ value: 102.3, ts: Date.now(), components: { EURUSD: 1.1, USDJPY: 150, GBPUSD: 1.3, USDCAD: 1.4, USDSEK: 9.5, USDCHF: 0.82 } }),
  };
});

import { isWarming } from "../src/lib/warming";
import { market } from "../src/services/market";
import { getDxy, getWarmupStatus } from "../src/services/metals";
import { getSetupsFor } from "../src/services/analysis";

describe("history with gaps", () => {
  beforeAll(() => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 11, 12, 0, 0), toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.stubGlobal("fetch", async () => {
      throw new Error("no network in this test");
    });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const settle = async <T>(p: Promise<T>, ms = 2600) => {
    const out = p.then(
      (value) => ({ value, error: null as unknown }),
      (error: unknown) => ({ value: null as T | null, error }),
    );
    await vi.advanceTimersByTimeAsync(ms);
    return out;
  };

  it("holds gappy gold and silver history back for a few minutes instead of presenting it as whole", async () => {
    const first = await settle(Promise.allSettled([market.getCandles("XAUUSD", "1h", 300), market.getCandles("XAGUSD", "1h", 300)]));
    for (const r of first.value!) expect(r.status === "rejected" && isWarming(r.reason)).toBe(true);
    await settle(getSetupsFor(["XAUUSD", "XAGUSD"], "1h")); // starts the other timeframes too
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    for (const id of ["XAUUSD", "XAGUSD"]) {
      const stillWaiting = await settle(market.getCandles(id, "1h", 300));
      expect(isWarming(stillWaiting.error)).toBe(true);
    }
    expect(getWarmupStatus()).toMatchObject({ goldGaps: false, silverGaps: false }); // nothing gappy is being served yet
  });

  it("then serves it flagged, warns in plain words, and withholds setups", async () => {
    await vi.advanceTimersByTimeAsync(80_000);
    const candles = await settle(market.getCandles("XAUUSD", "1h", 300));
    expect(candles.error).toBeNull();
    expect(candles.value?.candles.length).toBe(300);
    expect(candles.value?.source.incomplete).toBe(true);
    expect(candles.value?.source.quality).not.toBe("demo");
    expect(candles.value?.source.note).toContain("has gaps");
    expect(candles.value?.warnings.join(" ")).toContain("setups are withheld");
    expect(getWarmupStatus().goldGaps).toBe(true);
    const setups = await settle(getSetupsFor(["XAUUSD"], "1h"));
    expect(setups.value?.warming).toEqual([]);
    const plan = setups.value!.setups[0];
    expect(plan.status).toBe("NO TRADE");
    expect(plan.rationale.join(" ")).toContain("still has gaps");
    expect(plan.rationale.join(" ")).toContain("No setup is generated on incomplete data");
  });

  it("flags silver gaps on their own, the same way", async () => {
    const candles = await settle(market.getCandles("XAGUSD", "1h", 300));
    expect(candles.value?.source.incomplete).toBe(true);
    expect(candles.value?.source.label).toContain("Spot XAG/USD");
    expect(candles.value?.warnings.join(" ")).toContain("XAG/USD 1h: part of the price history could not be downloaded yet");
    expect(getWarmupStatus().silverGaps).toBe(true);
    const setups = await settle(getSetupsFor(["XAGUSD"], "1h"));
    expect(setups.value!.setups[0].status).toBe("NO TRADE");
    expect(setups.value!.setups[0].rationale.join(" ")).toContain("still has gaps");
  });

  it("never builds the dollar index from a gappy history: the live value stays, the history waits", async () => {
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    const dxy = await settle(getDxy());
    expect(dxy.value?.value).toBe(102.3);
    expect(dxy.value?.historyWarming).toBe(true);
    expect(dxy.value?.history1d).toEqual([]);
    const macro = await settle(market.getMacro(), 3000);
    expect(macro.value?.dxyWarming).toBe(true);
  });

  it("clears the flag and the warnings by itself once the missing files have arrived", async () => {
    archive.goldMissing = 0;
    archive.silverMissing = 0;
    archive.fxMissing = 0;
    await vi.advanceTimersByTimeAsync(61_000); // past the short lifetimes used while gaps exist
    await settle(market.getCandles("XAUUSD", "1h", 300), 600);
    const candles = await settle(market.getCandles("XAUUSD", "1h", 300), 600);
    expect(candles.value?.source.incomplete).toBeUndefined();
    expect(candles.value?.warnings).toEqual([]);
    const dxy = await settle(getDxy());
    expect(dxy.value?.historyWarming).toBe(false);
    expect(dxy.value?.history1d.length).toBeGreaterThan(60);
    await vi.advanceTimersByTimeAsync(61_000);
    await settle(getSetupsFor(["XAUUSD"], "1h"), 6000); // (the posture's macro lookups retry for a few seconds without a network)
    const setups = await settle(getSetupsFor(["XAUUSD"], "1h"), 6000);
    expect(setups.value!.setups[0].rationale.join(" ")).not.toContain("gaps");
    await settle(getSetupsFor(["XAGUSD"], "1h"), 6000);
    const silver = await settle(market.getCandles("XAGUSD", "1h", 300), 600);
    expect(silver.value?.source.incomplete).toBeUndefined();
    expect(getWarmupStatus()).toMatchObject({ goldGaps: false, silverGaps: false });
  });
});

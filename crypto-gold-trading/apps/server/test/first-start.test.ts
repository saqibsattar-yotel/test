/**
 * First start on a machine with an empty archive cache: the history download takes minutes, and no
 * request may wait for it or be answered with demo data in the meantime.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Candle } from "@terminal/core";

const archive = vi.hoisted(() => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open, requests: 0 };
});

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
function series(from: number, to: number, step: number, base: number): Candle[] {
  const out: Candle[] = [];
  for (let t = Math.floor(from / step) * step, i = 0; t < to; t += step, i++) {
    const day = new Date(t).getUTCDay();
    if (day === 6) continue; // no trading on Saturdays
    const close = base + Math.sin(i / 7) * 5 + i * 0.01;
    out.push({ time: t, open: close - 0.4, high: close + 1, low: close - 1, close, volume: 10 });
  }
  return out;
}

vi.mock("../src/providers/dukascopy", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/providers/dukascopy")>();
  const slow = async <T>(make: () => T): Promise<T> => {
    archive.requests++;
    await archive.gate; // the "download" finishes only when the test opens the gate
    return make();
  };
  const base = (instrument: string) => (instrument === "XAUUSD" ? 4000 : instrument === "USDJPY" ? 150 : instrument === "USDSEK" ? 9.5 : 1.1);
  return {
    ...real,
    dukascopy: {
      stats: { downloaded: 0, failed: 0, misses: 0 },
      progress: () => ({ downloaded: 0, failed: 0, active: 3, queued: 40 }),
      minuteSeries: (instrument: string, from: number, now: number) => slow(() => series(from, now, MIN, base(instrument))),
      hourlySeries: (instrument: string, months: number, now: number) => slow(() => series(now - months * 30 * DAY, now, HOUR, base(instrument))),
      dailySeries: (instrument: string, years: number, now: number) => slow(() => series(now - years * 365 * DAY, now, DAY, base(instrument))),
    },
  };
});

vi.mock("../src/providers/swissquote", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/providers/swissquote")>();
  return {
    ...real,
    getSwissquoteQuote: async (instrument: string) => ({ instrument, bid: 4010, ask: 4011, mid: 4010.5, spread: 1, ts: Date.now() }),
    getLiveDxyFromSwissquote: async () => ({ value: 102.3, ts: Date.now(), components: { EURUSD: 1.1, USDJPY: 150, GBPUSD: 1.3, USDCAD: 1.4, USDSEK: 9.5, USDCHF: 0.82 } }),
  };
});

import { isWarming } from "../src/lib/warming";
import { market } from "../src/services/market";
import { getDxy, getGoldVerification, getWarmupStatus } from "../src/services/gold";
import { getSetupsFor } from "../src/services/analysis";
import { buildServer } from "../src/server";

describe("first start with an empty archive cache", () => {
  beforeAll(() => {
    // A Wednesday with the market open. Only timers and the clock are faked, so the HTTP server still boots normally.
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

  it("answers 'still downloading' within seconds instead of waiting or falling back to demo candles", async () => {
    const candles = await settle(market.getCandles("XAUUSD", "1h", 300));
    expect(isWarming(candles.error)).toBe(true);
    expect((candles.error as Error).message).toContain("downloaded for the first time");
    const daily = await settle(market.getCandles("XAUUSD", "1d", 300));
    expect(isWarming(daily.error)).toBe(true);
  });

  it("omits the gold quote rather than inventing a demo price", async () => {
    const quotes = await settle(market.getQuotes(["XAUUSD"]));
    expect(quotes.error).toBeNull();
    expect(quotes.value).toEqual([]);
  });

  it("still serves the live dollar-index value, flagged as missing its history", async () => {
    const dxy = await settle(getDxy());
    expect(dxy.error).toBeNull();
    expect(dxy.value?.value).toBe(102.3);
    expect(dxy.value?.historyWarming).toBe(true);
    expect(dxy.value?.history1d).toEqual([]);
    const verification = await settle(getGoldVerification(), 2600);
    expect(verification.value?.warming).toBe(true);
    expect(verification.value?.spot.dukascopyLastClose).toBeNull();
    expect(verification.value?.spot.swissquote?.price).toBe(4010.5);
  });

  it("reports gold as warming in multi-asset answers instead of failing them", async () => {
    const setups = await settle(getSetupsFor(["XAUUSD"], "1h"));
    expect(setups.error).toBeNull();
    expect(setups.value?.warming).toEqual(["XAUUSD"]);
    expect(setups.value?.errors.XAUUSD).toContain("downloaded for the first time");
  });

  it("answers over HTTP with 202 and a warming flag instead of an error status", async () => {
    const app = await buildServer();
    try {
      const res = await settle(app.inject({ method: "GET", url: "/api/market/candles/XAUUSD?tf=4h&limit=600" }));
      expect(res.error).toBeNull();
      expect(res.value?.statusCode).toBe(202);
      expect(res.value?.headers["retry-after"]).toBe("5");
      expect(res.value?.json()).toMatchObject({ warming: true });
      expect(res.value?.json().error).toContain("downloaded for the first time");
      const status = await app.inject({ method: "GET", url: "/api/status/warmup" });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ files: { queued: 40 } });
    } finally {
      await app.close();
    }
  });

  it("did not start a second download for repeated requests", () => {
    // 1h + 1d gold, recent days for the quote, archive hours for verification, 2 dollar-index series × 6 pairs,
    // plus the four series the setup needs: every one requested exactly once however often it was asked for.
    const before = archive.requests;
    void market.getCandles("XAUUSD", "1h", 300).catch(() => undefined);
    void market.getCandles("XAUUSD", "1h", 300).catch(() => undefined);
    void getDxy().catch(() => undefined);
    expect(archive.requests).toBe(before);
    expect(getWarmupStatus().files.queued).toBe(40);
  });

  it("serves real data, clearly sourced, as soon as the download completes", async () => {
    archive.open();
    await vi.advanceTimersByTimeAsync(10);
    const candles = await settle(market.getCandles("XAUUSD", "1h", 300), 50);
    expect(candles.error).toBeNull();
    expect(candles.value?.candles.length).toBe(300);
    expect(candles.value?.source.provider).toBe("dukascopy+swissquote");
    expect(candles.value?.source.quality).not.toBe("demo");
    await vi.advanceTimersByTimeAsync(5001); // the 5 s quote cache from the warming phase expires
    const quotes = await settle(market.getQuotes(["XAUUSD"]), 50);
    expect(quotes.value).toHaveLength(1);
    const q = quotes.value![0];
    expect(q.price).toBe(4010.5);
    expect(q.source.provider).toBe("swissquote");
    expect(Number.isFinite(q.changePct24h)).toBe(true);
    expect(q.changePct24h).not.toBe(0); // measured against a real previous close
    const dxy = await settle(getDxy(), 50);
    expect(dxy.value?.historyWarming).toBe(false);
    expect(dxy.value?.history1d.length).toBeGreaterThan(300);
  });
});

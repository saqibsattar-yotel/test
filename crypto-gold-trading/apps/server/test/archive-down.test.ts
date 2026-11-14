/**
 * The archive answers nothing at all (down, or blocking this connection) on a machine with an empty
 * cache. Gold and silver history is then reported as unavailable: never replaced by demo candles, never
 * turned into a posture or a trade plan, and reported in the terminal once, not once per request.
 * Live prices keep working, without an invented change figure.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Candle } from "@terminal/core";

const archive = vi.hoisted(() => ({ down: true, lines: [] as string[] }));

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
function series(from: number, to: number, step: number, base: number): Candle[] {
  const out: Candle[] = [];
  for (let t = Math.floor(from / step) * step, i = 0; t < to; t += step, i++) {
    if (new Date(t).getUTCDay() === 6) continue;
    const close = base + Math.sin(i / 7) * (base / 800) + i * (base / 400_000);
    out.push({ time: t, open: close * 0.9999, high: close * 1.0003, low: close * 0.9997, close, volume: 10 });
  }
  return out;
}

vi.mock("../src/providers/dukascopy", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/providers/dukascopy")>();
  const base = (instrument: string) => (instrument === "XAUUSD" ? 4000 : instrument === "XAGUSD" ? 48 : instrument === "USDJPY" ? 150 : instrument === "USDSEK" ? 9.5 : 1.1);
  // Down: every file of the series failed, so there are no candles and plenty of gaps.
  const build = async (candles: () => Candle[]) => (archive.down ? { candles: [], missing: 9 } : { candles: candles(), missing: 0 });
  return {
    ...real,
    dukascopy: {
      stats: { downloaded: 0, failedAttempts: 0 },
      progress: () => ({ gold: { total: 24, done: 0, failing: 6 }, silver: { total: 24, done: 0, failing: 6 }, other: { total: 96, done: 0, failing: 0 }, active: 0, queued: 0, state: "paused", resumesAt: Date.now() + 120_000, nextRetryAt: Date.now() + 60_000 }),
      minuteSeries: (instrument: string, from: number, now: number) => build(() => series(from, now, MIN, base(instrument))),
      hourlySeries: (instrument: string, months: number, now: number) => build(() => series(now - months * 30 * DAY, now, HOUR, base(instrument))),
      dailySeries: (instrument: string, years: number, now: number) => build(() => series(now - years * 365 * DAY, now, DAY, base(instrument))),
      recentDailySeries: (instrument: string, months: number, now: number) => build(() => series(now - months * 30 * DAY, now, DAY, base(instrument))),
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

import { isUnavailable, isWarming } from "../src/lib/warming";
import { market } from "../src/services/market";
import { getGoldSilverRatio, getMetalVerification, getWarmupStatus, prewarm } from "../src/services/metals";
import { getMetalRegime, getSetupsFor } from "../src/services/analysis";
import { buildServer } from "../src/server";

describe("the archive delivers nothing at all", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeAll(() => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 11, 12, 0, 0), toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.stubGlobal("fetch", async () => {
      throw new Error("no network in this test");
    });
    logSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => void archive.lines.push(String(line)));
  });
  afterAll(() => {
    logSpy.mockRestore();
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
  const linesAbout = (text: string) => archive.lines.filter((l) => l.includes(text));

  it("keeps answering 'still downloading' during the patience window", async () => {
    // As at server start: every gold and silver series begins to load now, so their patience windows run together.
    void prewarm();
    const first = await settle(Promise.allSettled([market.getCandles("XAUUSD", "1h", 300), market.getCandles("XAGUSD", "1h", 300)]));
    for (const r of first.value!) expect(r.status === "rejected" && isWarming(r.reason)).toBe(true);
    expect(getWarmupStatus()).toMatchObject({ warming: true, unavailable: [] });
  });

  it("then says the history is unavailable instead of serving demo candles", async () => {
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 20_000);
    for (const [id, name] of [["XAUUSD", "gold"], ["XAGUSD", "silver"]] as const) {
      const candles = await settle(market.getCandles(id, "1h", 300));
      expect(candles.value).toBeNull(); // in particular: no DEMO payload
      expect(isUnavailable(candles.error)).toBe(true);
      expect(isWarming(candles.error)).toBe(false);
      expect((candles.error as Error).message).toBe(`Spot ${name} price history could not be downloaded yet: the archive is not answering. It is retried automatically, and nothing is shown in its place.`);
    }
    expect(getWarmupStatus()).toMatchObject({ warming: false, unavailable: ["gold", "silver"], goldGaps: false, silverGaps: false });
    expect(getWarmupStatus().steps.every((step) => step.state === "done")).toBe(true); // the first round is over; nothing "failed", it simply has nothing yet
  });

  it("builds no posture and no trade plan on missing history", async () => {
    const posture = await settle(getMetalRegime("silver"), 6000);
    expect(posture.value).toBeNull();
    expect(isUnavailable(posture.error)).toBe(true);
    const setups = await settle(getSetupsFor(["XAUUSD", "XAGUSD"], "1h"), 6000);
    expect(setups.value?.setups).toEqual([]);
    expect(setups.value?.warming).toEqual([]);
    expect(setups.value?.errors.XAGUSD).toContain("could not be downloaded yet");
    expect(setups.value?.errors.XAUUSD).toContain("could not be downloaded yet");
  });

  it("still shows the live prices, without an invented change", async () => {
    const quotes = await settle(market.getQuotes(["XAUUSD", "XAGUSD"]), 6000);
    const silver = quotes.value?.find((q) => q.assetId === "XAGUSD");
    expect(silver?.price).toBe(48.63);
    expect(silver?.source.quality).not.toBe("demo");
    expect(silver?.change24h).toBeNull();
    expect(silver?.changePct24h).toBeNull();
    expect(silver?.source.note).toContain("no change is shown");
    expect(quotes.value?.find((q) => q.assetId === "XAUUSD")?.changePct24h).toBeNull();
    const ratio = await settle(getGoldSilverRatio(), 50);
    expect(ratio.value?.value).toBeCloseTo(4010.5 / 48.63, 6);
    expect(ratio.value?.year).toBeNull();
    const verification = await settle(getMetalVerification("XAGUSD"), 6000);
    expect(verification.value?.spot.dukascopyLastClose).toBeNull();
    expect(verification.value?.spot.swissquote?.price).toBe(48.63);
  });

  it("answers with a plain reason over HTTP, for charts, analysis and posture alike", async () => {
    const app = await buildServer();
    try {
      for (const url of ["/api/market/candles/XAGUSD?tf=4h&limit=600", "/api/market/candles/XAUUSD?tf=1d&limit=300", "/api/analysis/XAGUSD", "/api/regime/silver", "/api/regime/gold"]) {
        const res = await settle(app.inject({ method: "GET", url }), 6000);
        expect(res.value?.statusCode, url).toBe(202); // not an error status: the server keeps trying, and says so
        expect(res.value?.headers["retry-after"], url).toBe("30");
        expect(res.value?.json(), url).toMatchObject({ unavailable: true });
        expect(res.value?.json().warming, url).toBeUndefined(); // a different state from "still downloading"
        expect(res.value?.json().error, url).toContain("could not be downloaded yet");
        expect(JSON.stringify(res.value?.json()), url).not.toContain("DEMO");
      }
      const status = await app.inject({ method: "GET", url: "/api/status/warmup" });
      expect(status.json()).toMatchObject({ unavailable: ["gold", "silver"] });
    } finally {
      await app.close();
    }
  });

  it("reported the outage once per metal, however many requests ran into it", async () => {
    for (let i = 0; i < 25; i++) {
      await settle(market.getCandles("XAUUSD", "1h", 300), 10);
      await settle(market.getCandles("XAGUSD", "4h", 300), 10);
    }
    expect(linesAbout("spot gold history is unavailable")).toHaveLength(1);
    expect(linesAbout("spot silver history is unavailable")).toHaveLength(1);
    expect(linesAbout("serving DEMO")).toHaveLength(0);
    expect(linesAbout("candles failed")).toHaveLength(0);
    expect(linesAbout("request failed")).toHaveLength(0);
  });

  it("serves the real history by itself once the archive answers again, and says so once", async () => {
    archive.down = false;
    await vi.advanceTimersByTimeAsync(61_000); // past the short lifetime of the empty series
    await settle(Promise.allSettled([market.getCandles("XAUUSD", "1h", 300), market.getCandles("XAGUSD", "1h", 300)]), 600);
    for (const id of ["XAUUSD", "XAGUSD"] as const) {
      const candles = await settle(market.getCandles(id, "1h", 300), 600);
      expect(candles.error).toBeNull();
      expect(candles.value?.candles.length).toBe(300);
      expect(candles.value?.source.quality).not.toBe("demo");
    }
    expect(getWarmupStatus().unavailable).toEqual([]);
    expect(linesAbout("spot gold history is arriving")).toHaveLength(1);
    expect(linesAbout("spot silver history is arriving")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31_000); // the quote's previous close is refreshed
    await settle(market.getQuotes(["XAGUSD"]), 600);
    const quotes = await settle(market.getQuotes(["XAGUSD"]), 600);
    expect(quotes.value?.[0]?.changePct24h).not.toBeNull();
  });

  it("completes the series nobody asked for again as well, so no 'history is missing' notice is left behind", async () => {
    // Only the 1h charts were requested since the archive came back; the 5m, 15m, 4h, daily and weekly
    // series of both metals were last built empty. They rebuild by themselves within their short lifetime.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(getWarmupStatus()).toMatchObject({ warming: false, goldGaps: false, silverGaps: false, unavailable: [] });
    const weekly = await settle(market.getCandles("XAGUSD", "1w", 100), 50);
    expect(weekly.error).toBeNull();
    expect(weekly.value?.source.incomplete).toBeUndefined();
    expect(weekly.value?.candles.length).toBe(100);
  });
});

/**
 * The archive limits how much one address may download. These tests pin down that the client backs off,
 * pauses and recovers instead of retrying in a loop, and that it reports what it is doing accurately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ArchiveHttpError, ArchiveMiss, DukascopyClient, type ArchiveOptions } from "../src/providers/dukascopy";

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0); // Wednesday, market open
const DAY = 86_400_000;
const refuse = (path: string) => new ArchiveHttpError(503, path);

type Answer = Buffer | null | Error;
function setup(answer: (path: string, call: number) => Answer | Promise<Answer>, options: ArchiveOptions = {}) {
  const calls: { path: string; at: number }[] = [];
  const logs: { level: "debug" | "info" | "warn"; message: string }[] = [];
  let active = 0;
  const peak = { all: 0, background: 0 };
  let activeBackground = 0;
  const client = new DukascopyClient({
    cacheDir: null,
    random: () => 0.5, // no jitter: pauses are exactly 30 s, 60 s, 120 s …
    minIntervalMs: 0,
    backgroundIntervalMs: 0,
    networkRetryDelayMs: 1000,
    log: { debug: (message) => logs.push({ level: "debug", message }), info: (message) => logs.push({ level: "info", message }), warn: (message) => logs.push({ level: "warn", message }) },
    fetchFile: async (path) => {
      calls.push({ path, at: Date.now() });
      const background = !/^XA[UG]USD\//.test(path); // gold and silver are foreground work, FX is background
      active++;
      if (background) activeBackground++;
      peak.all = Math.max(peak.all, active);
      peak.background = Math.max(peak.background, activeBackground);
      try {
        const result = await answer(path, calls.length);
        if (result instanceof Error) throw result;
        return result;
      } finally {
        active--;
        if (background) activeBackground--;
      }
    },
    ...options,
  });
  return { client, calls, logs, peak };
}
const day = (n: number) => NOW - (NOW % DAY) - n * DAY;
const settle = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const slow = <T>(value: T, ms: number) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe("archive client: retries", () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  it("leaves a failed file alone for 30 s, then 1, 2 and 4 minutes, never retrying in a loop", async () => {
    const { client, calls } = setup((path) => refuse(path));
    const load = () => settle(client.dayMinuteFile("XAUUSD", day(1), NOW));
    const first = await load();
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error).toBeInstanceOf(ArchiveMiss);
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 20; i++) await load(); // however often it is asked for…
    expect(calls).toHaveLength(1); // …nothing is requested while the file is backing off
    const pauses = [30_000, 60_000, 120_000, 240_000];
    for (let i = 0; i < pauses.length; i++) {
      await tick(pauses[i] - 1);
      await load();
      expect(calls).toHaveLength(i + 1);
      await tick(1);
      await load();
      expect(calls).toHaveLength(i + 2);
    }
    client.dispose();
  });

  it("caps the pause at ten minutes", async () => {
    const { client, calls } = setup((path) => refuse(path));
    const load = () => settle(client.dayMinuteFile("XAUUSD", day(1), NOW));
    await load();
    for (let i = 0; i < 12; i++) {
      await tick(10 * 60_000);
      await load();
    }
    const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(10 * 60_000);
    expect(gaps.slice(-3)).toEqual([600_000, 600_000, 600_000]);
    client.dispose();
  });

  it("does not repeat a refused request, but gives a dropped connection one quick second try", async () => {
    const refused = setup((path) => refuse(path));
    await settle(refused.client.dayMinuteFile("XAUUSD", day(1), NOW));
    expect(refused.calls).toHaveLength(1);

    const dropped = setup((_path, call) => (call === 1 ? new TypeError("fetch failed") : null));
    const pending = settle(dropped.client.dayMinuteFile("XAUUSD", day(1), NOW));
    await tick(999);
    expect(dropped.calls).toHaveLength(1);
    await tick(1);
    expect((await pending).ok).toBe(true);
    expect(dropped.calls).toHaveLength(2);

    const timedOut = setup(() => Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
    await settle(timedOut.client.dayMinuteFile("XAUUSD", day(1), NOW));
    await tick(5000);
    expect(timedOut.calls).toHaveLength(1); // a timeout already cost 30 s: no immediate second attempt
  });
});

describe("archive client: pausing when the archive refuses downloads", () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  it("pauses every download after clustered failures, then resumes one at a time until it is healthy", async () => {
    let healthy = false;
    const { client, calls, logs, peak } = setup((path) => (healthy ? slow(null, 800) : refuse(path)));
    const files = Array.from({ length: 10 }, (_, i) => day(i + 1)).filter((d) => new Date(d).getUTCDay() !== 6);
    const loadAll = () => Promise.all(files.map((d) => settle(client.dayMinuteFile("XAUUSD", d, NOW))));
    const first = await loadAll();
    expect(first.every((r) => !r.ok)).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(5); // five failures trip the breaker…
    expect(calls.length).toBeLessThanOrEqual(7); // …and the rest of the batch is never sent
    expect(client.progress().state).toBe("paused");
    expect(client.progress().resumesAt).toBe(NOW + 60_000);
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(1); // one line, not one per file
    expect(logs.find((l) => l.level === "warn")?.message).toContain("pausing all archive downloads for 60 s");

    const sent = calls.length;
    await tick(45_000);
    await loadAll(); // the files' own pauses have passed, but the archive as a whole is paused
    expect(calls).toHaveLength(sent);

    healthy = true;
    await tick(15_000);
    expect(client.progress().state).toBe("recovering");
    peak.all = 0;
    const second = loadAll();
    await tick(2300); // the first three downloads (800 ms each) run strictly one after another
    expect(peak.all).toBe(1);
    expect(calls.length - sent).toBe(3);
    await tick(20_000);
    expect((await second).every((r) => r.ok)).toBe(true);
    expect(client.progress().state).toBe("ok");
    expect(peak.all).toBeGreaterThan(1); // parallel again once three in a row succeeded
    expect(logs.filter((l) => l.level === "info").map((l) => l.message)).toEqual(["archive downloads are back to normal", "archive: every file that had failed has now been downloaded"]);
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(1);
    expect(client.progress().gold).toEqual({ total: files.length, done: files.length, failing: 0 });
    client.dispose();
  });

  it("doubles the pause when the archive is still refusing after it", async () => {
    const { client, logs } = setup((path) => refuse(path));
    const files = Array.from({ length: 8 }, (_, i) => day(i + 8)).filter((d) => new Date(d).getUTCDay() !== 6);
    await Promise.all(files.map((d) => settle(client.dayMinuteFile("XAUUSD", d, NOW))));
    expect(client.progress().resumesAt).toBe(NOW + 60_000);
    await tick(60_000);
    await settle(client.dayMinuteFile("XAUUSD", files[0], NOW)); // the single careful try fails
    const p = client.progress();
    expect(p.state).toBe("paused");
    expect(p.resumesAt).toBe(NOW + 60_000 + 120_000);
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(1); // still only the first notice at warning level
    client.dispose();
  });
});

describe("archive client: slowing down when the archive limits downloads", () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  it("halves its pace after each refusal burst, keeps the pause short while downloads still get through, and speeds up again gradually", async () => {
    // An archive that lets a few downloads through and then refuses: it is limiting, not down.
    let allowance = 0;
    const { client, calls } = setup((path) => (allowance-- > 0 ? null : refuse(path)), { minIntervalMs: 100, backgroundIntervalMs: 0 });
    const files = Array.from({ length: 60 }, (_, i) => day(i + 1)).filter((d) => new Date(d).getUTCDay() !== 6);
    const run = async (ms: number) => {
      const pending = Promise.all(files.map((d) => settle(client.dayMinuteFile("XAUUSD", d, NOW))));
      await tick(ms);
      return pending;
    };
    const gaps = (from: number) => calls.slice(from + 1).map((c, i) => c.at - calls[from + i].at);

    // Round 1: refused from the first request. Normal pace (100 ms), then the first pause.
    await run(10_000);
    expect(gaps(0).every((g) => g >= 100)).toBe(true);
    expect(client.progress().state).toBe("paused");
    const firstPause = client.progress().resumesAt! - calls[calls.length - 1].at;
    expect(firstPause).toBeLessThanOrEqual(60_000);

    // Round 2: three downloads get through, then refusals again. Half the pace; the pause does not grow.
    await tick(60_000);
    allowance = 3;
    const round2 = calls.length;
    await run(30_000);
    expect(calls.length - round2).toBeGreaterThanOrEqual(8); // 3 successes + the 5 failures that trip it
    expect(gaps(round2).every((g) => g >= 500)).toBe(true);
    expect(client.progress().state).toBe("paused");
    expect(client.progress().resumesAt! - calls[calls.length - 1].at).toBeLessThanOrEqual(60_000);

    // Round 3: the archive accepts everything. Half the pace again, then faster step by step.
    await tick(60_000);
    allowance = 1000;
    const round3 = calls.length;
    const all = await run(10 * 60_000);
    expect(all.every((r) => r.ok)).toBe(true);
    const g = gaps(round3);
    expect(g[0]).toBeGreaterThanOrEqual(1000);
    expect(g[g.length - 1]).toBeLessThan(g[0]);
    expect(Math.min(...g)).toBeGreaterThanOrEqual(100); // never faster than the normal pace
    for (let i = 1; i < g.length; i++) expect(g[i]).toBeLessThanOrEqual(g[i - 1] + 1); // it only ever speeds up while things work
    client.dispose();
  });

  it("waits at least as long as the archive asks for", async () => {
    const { client } = setup((path) => new ArchiveHttpError(503, path, 300_000));
    const files = Array.from({ length: 8 }, (_, i) => day(i + 8)).filter((d) => new Date(d).getUTCDay() !== 6);
    await Promise.all(files.map((d) => settle(client.dayMinuteFile("XAUUSD", d, NOW))));
    expect(client.progress().state).toBe("paused");
    expect(client.progress().resumesAt).toBe(NOW + 300_000);
    client.dispose();
  });
});

describe("archive client: pacing and priorities", () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  it("runs at most three downloads at once, at most two of them for the dollar index, and gold first", async () => {
    const { client, calls, peak } = setup(() => slow(null, 100));
    const fx = Array.from({ length: 6 }, (_, i) => settle(client.dayMinuteFile("EURUSD", day(i + 1 + (i >= 3 ? 1 : 0)), NOW)));
    const gold = [2, 3, 4].map((n) => settle(client.dayMinuteFile("XAUUSD", day(n), NOW)));
    await tick(2000);
    await Promise.all([...fx, ...gold]);
    expect(peak.all).toBe(3);
    expect(peak.background).toBe(2);
    const order = calls.map((c) => c.path.slice(0, 6));
    expect(order.slice(0, 3).sort()).toEqual(["EURUSD", "EURUSD", "XAUUSD"]); // the free third slot goes to gold at once
    expect(order.lastIndexOf("XAUUSD")).toBeLessThan(order.lastIndexOf("EURUSD")); // gold never waits behind the FX backlog
    client.dispose();
  });

  it("treats silver as a metal: ahead of the dollar index, behind gold within the same kind of file", async () => {
    const { client, calls } = setup(() => slow(null, 100), { concurrency: 1 });
    // Asked for in the "wrong" order on purpose. The first file takes the only slot before the rest is queued.
    const loads = [
      ...[1, 2].map((n) => client.dayMinuteFile("EURUSD", day(n), NOW)),
      ...[1, 2].map((n) => client.dayMinuteFile("XAGUSD", day(n), NOW)),
      client.monthHourFile("XAGUSD", 2025, 8, NOW),
      client.monthHourFile("XAUUSD", 2025, 8, NOW),
      ...[2, 1].map((n) => client.dayMinuteFile("XAUUSD", day(n), NOW)),
    ].map(settle);
    await tick(5000);
    await Promise.all(loads);
    const order = calls.map((c) => `${c.path.slice(0, 6)} ${c.path.includes("min_1") ? `minutes day-${Math.round((day(0) - Date.UTC(+c.path.slice(7, 11), +c.path.slice(12, 14), +c.path.slice(15, 17))) / DAY)}` : "month"}`);
    expect(order).toEqual(["EURUSD minutes day-1", "XAUUSD minutes day-1", "XAUUSD minutes day-2", "XAGUSD minutes day-1", "XAGUSD minutes day-2", "XAUUSD month", "XAGUSD month", "EURUSD minutes day-2"]);
    expect(client.progress()).toMatchObject({ gold: { total: 3, done: 3, failing: 0 }, silver: { total: 3, done: 3, failing: 0 }, other: { total: 2, done: 2, failing: 0 } });
    client.dispose();
  });

  it("counts failing silver files under silver, not under gold or the dollar index", async () => {
    const { client } = setup((path) => (path.startsWith("XAGUSD/") ? new ArchiveHttpError(503, path) : null));
    await Promise.all([settle(client.dayMinuteFile("XAGUSD", day(1), NOW)), settle(client.dayMinuteFile("XAUUSD", day(1), NOW)), settle(client.dayMinuteFile("EURUSD", day(1), NOW))]);
    expect(client.progress()).toMatchObject({ gold: { total: 1, done: 1, failing: 0 }, silver: { total: 1, done: 0, failing: 1 }, other: { total: 1, done: 1, failing: 0 } });
    client.dispose();
  });

  it("spaces download starts out", async () => {
    const { client, calls } = setup(() => null, { minIntervalMs: 100, backgroundIntervalMs: 350 });
    const loads = [1, 2, 3, 4].map((n) => settle(client.dayMinuteFile("XAUUSD", day(n + 7), NOW)));
    const fx = [1, 2, 3].map((n) => settle(client.dayMinuteFile("USDJPY", day(n + 7), NOW)));
    await tick(5000);
    await Promise.all([...loads, ...fx]);
    const goldStarts = calls.filter((c) => c.path.startsWith("XAUUSD")).map((c) => c.at - NOW);
    const fxStarts = calls.filter((c) => c.path.startsWith("USDJPY")).map((c) => c.at - NOW);
    for (let i = 1; i < goldStarts.length; i++) expect(goldStarts[i] - goldStarts[i - 1]).toBeGreaterThanOrEqual(100);
    for (let i = 1; i < fxStarts.length; i++) expect(fxStarts[i] - fxStarts[i - 1]).toBeGreaterThanOrEqual(350);
    client.dispose();
  });
});

describe("archive client: what is requested", () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());
  const kinds = (paths: string[]) => ({
    minute: paths.filter((p) => p.endsWith("BID_candles_min_1.bi5")).length,
    ticks: paths.filter((p) => p.endsWith("h_ticks.bi5")).length,
    month: paths.filter((p) => p.endsWith("BID_candles_hour_1.bi5")).length,
    year: paths.filter((p) => p.endsWith("BID_candles_day_1.bi5")).length,
  });

  it("fetches today's tick files for gold but not for dollar-index pairs", async () => {
    const gold = setup(() => null);
    await gold.client.minuteSeries("XAUUSD", NOW - 3 * DAY, NOW);
    expect(kinds(gold.calls.map((c) => c.path))).toEqual({ minute: 3, ticks: 12, month: 0, year: 0 }); // 00:00–11:59 UTC so far today
    const fx = setup(() => null);
    await fx.client.minuteSeries("EURUSD", NOW - 3 * DAY, NOW, { today: false });
    expect(kinds(fx.calls.map((c) => c.path))).toEqual({ minute: 3, ticks: 0, month: 0, year: 0 });
  });

  it("builds the dollar-index daily history from four month files plus this month, without year files", async () => {
    const { client, calls } = setup(() => null);
    const build = await client.recentDailySeries("USDCHF", 4, NOW, { today: false });
    expect(build.missing).toBe(0);
    const k = kinds(calls.map((c) => c.path));
    expect(k).toEqual({ minute: 9, ticks: 0, month: 4, year: 0 }); // 1–10 November without the Saturday
    expect(calls.map((c) => c.path).filter((p) => p.endsWith("hour_1.bi5")).sort()).toEqual(["USDCHF/2026/06/BID_candles_hour_1.bi5", "USDCHF/2026/07/BID_candles_hour_1.bi5", "USDCHF/2026/08/BID_candles_hour_1.bi5", "USDCHF/2026/09/BID_candles_hour_1.bi5"]);
  });

  it("reports how many files a series is still missing instead of failing or logging per file", async () => {
    const { client, logs } = setup((path) => (path.includes("/10/09/") || path.includes("/10/06/") ? refuse(path) : null));
    const build = await client.minuteSeries("XAUUSD", NOW - 6 * DAY, NOW, { today: false });
    expect(build.missing).toBe(2);
    expect(logs.filter((l) => l.level !== "debug")).toEqual([]);
    expect(client.progress().gold).toEqual({ total: 5, done: 3, failing: 2 });
  });
});

describe("archive client: decoding", () => {
  it("decodes a downloaded month of hourly candles and counts it", async () => {
    const fixture = fs.readFileSync(fileURLToPath(new URL("./fixtures/XAUUSD_2026-10_hour.bi5", import.meta.url)));
    const { client } = setup(() => fixture);
    const candles = await client.monthHourFile("XAUUSD", 2026, 9, NOW);
    expect(candles).toHaveLength(504);
    expect(candles?.[candles.length - 1].close).toBeCloseTo(3874.585, 3);
    expect(client.stats).toEqual({ downloaded: 1, failedAttempts: 0 });
    expect(await client.monthHourFile("XAUUSD", 2026, 9, NOW)).toBe(candles); // served from memory, not downloaded again
    expect(client.stats.downloaded).toBe(1);
  });
});

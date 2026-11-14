import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WarmSeries, WarmingError, isWarming, within } from "../src/lib/warming";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("within", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the value when it arrives in time and reports a timeout otherwise", async () => {
    const fast = deferred<number>();
    const a = within(fast.promise, 1000);
    fast.resolve(7);
    await expect(a).resolves.toEqual({ done: true, value: 7 });
    const slow = deferred<number>();
    const b = within(slow.promise, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(b).resolves.toEqual({ done: false });
    await expect(within(Promise.resolve(1), Infinity)).resolves.toEqual({ done: true, value: 1 });
  });
  it("rethrows a rejection that happens inside the window", async () => {
    await expect(within(Promise.reject(new Error("boom")), 1000)).rejects.toThrow("boom");
  });
});

describe("WarmSeries", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("answers 'warming' quickly on a cold start, keeps one download running, and serves it when done", async () => {
    const first = deferred<{ value: number[]; ttlMs: number }>();
    const loader = vi.fn(() => first.promise);
    const series = new WarmSeries("Gold history", loader);
    const a = series.get(2500).catch((e) => e);
    const b = series.get(2500).catch((e) => e);
    await vi.advanceTimersByTimeAsync(2500);
    const [ea, eb] = await Promise.all([a, b]);
    expect(ea).toBeInstanceOf(WarmingError);
    expect(isWarming(eb)).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1); // concurrent and repeated callers share the same download
    expect(series.ready).toBe(false);
    void series.get(10).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(loader).toHaveBeenCalledTimes(1);
    first.resolve({ value: [1, 2, 3], ttlMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(series.ready).toBe(true);
    await expect(series.get(2500)).resolves.toEqual([1, 2, 3]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("waits for the full result when asked to (background warm-up)", async () => {
    const first = deferred<{ value: string; ttlMs: number }>();
    const series = new WarmSeries("x", () => first.promise);
    const p = series.get(Infinity);
    await vi.advanceTimersByTimeAsync(600_000);
    first.resolve({ value: "ready", ttlMs: 1000 });
    await expect(p).resolves.toBe("ready");
  });

  it("serves the previous value while a slow refresh runs, then the new one", async () => {
    const loads = [deferred<{ value: string; ttlMs: number }>(), deferred<{ value: string; ttlMs: number }>()];
    let n = 0;
    const series = new WarmSeries("x", () => loads[n++].promise);
    const p = series.get(Infinity);
    loads[0].resolve({ value: "v1", ttlMs: 1000 });
    await expect(p).resolves.toBe("v1");
    await vi.advanceTimersByTimeAsync(1001); // v1 expired
    const stale = series.get(2500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(stale).resolves.toBe("v1"); // no error, and only a short wait for the refresh
    loads[1].resolve({ value: "v2", ttlMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(series.get(2500)).resolves.toBe("v2");
    expect(n).toBe(2);
  });

  it("keeps the last good value when a refresh fails and backs off before retrying", async () => {
    let n = 0;
    const series = new WarmSeries<string>("x", async () => {
      n++;
      if (n === 1) return { value: "good", ttlMs: 1000 };
      throw new Error("archive unreachable");
    }, { retryAfterFailureMs: 30_000 });
    await expect(series.get(2500)).resolves.toBe("good");
    await vi.advanceTimersByTimeAsync(1001);
    await expect(series.get(2500)).resolves.toBe("good"); // failed refresh → previous value
    expect(series.lastError?.message).toBe("archive unreachable");
    await expect(series.get(2500)).resolves.toBe("good");
    expect(n).toBe(2); // not hammering the archive
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(series.get(2500)).resolves.toBe("good");
    expect(n).toBe(3);
  });

  it("reports a real failure (not 'warming') when the first load fails", async () => {
    const series = new WarmSeries<string>("x", async () => {
      throw new Error("archive unreachable");
    });
    const err = await series.get(2500).catch((e) => e);
    expect(isWarming(err)).toBe(false);
    expect((err as Error).message).toBe("archive unreachable");
    expect(series.ready).toBe(false);
  });

  describe("first loads with gaps (some downloads failed)", () => {
    it("holds a gappy first value back, rebuilds it on a timer and serves it once it is whole", async () => {
      let n = 0;
      const start = Date.now();
      const series = new WarmSeries<string>("Gold history", async () => (++n < 3 ? { value: "gappy", ttlMs: 45_000, complete: false } : { value: "whole", ttlMs: 60_000 }), { partialAllowedAt: () => start + 240_000, rebuildMs: 10_000 });
      const first = series.get(2500).catch((e) => e);
      await vi.advanceTimersByTimeAsync(2500);
      expect(isWarming(await first)).toBe(true);
      expect(series.ready).toBe(false);
      expect(series.loading).toBe(true); // a rebuild is scheduled without anyone asking
      for (let i = 0; i < 5; i++) void series.get(100).catch(() => undefined); // impatient callers do not speed it up
      await vi.advanceTimersByTimeAsync(100);
      expect(n).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000 - 2600);
      expect(n).toBe(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(n).toBe(3);
      await expect(series.get(2500)).resolves.toBe("whole");
      expect(series.incomplete).toBe(false);
    });

    it("serves the gappy value, flagged incomplete, once the patience window has passed", async () => {
      let whole = false;
      const start = Date.now();
      const series = new WarmSeries<string>("Gold history", async () => (whole ? { value: "whole", ttlMs: 60_000 } : { value: "gappy", ttlMs: 45_000, complete: false }), { partialAllowedAt: () => start + 60_000, rebuildMs: 10_000 });
      const waiting = series.get(Infinity);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(series.ready).toBe(false);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(waiting).resolves.toBe("gappy");
      expect(series.incomplete).toBe(true);
      whole = true; // the missing files arrive
      await vi.advanceTimersByTimeAsync(45_001);
      await series.get(2500);
      await expect(series.get(2500)).resolves.toBe("whole");
      expect(series.incomplete).toBe(false);
    });

    it("never serves a gappy first value when told not to", async () => {
      let n = 0;
      let whole = false;
      const series = new WarmSeries<string>("Dollar index history", async () => (++n, whole ? { value: "whole", ttlMs: 60_000 } : { value: "gappy", ttlMs: 60_000, complete: false }), { partialAllowedAt: () => Infinity, rebuildMs: 20_000 });
      const first = series.get(800).catch((e) => e);
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(isWarming(await first)).toBe(true);
      expect(series.ready).toBe(false);
      expect(n).toBeGreaterThan(100); // it kept trying (the downloader decides what is really re-requested)
      expect(n).toBeLessThanOrEqual(181); // …but only every 20 s
      whole = true;
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(series.get(800)).resolves.toBe("whole");
    });

    it("keeps completing a value that was published with gaps, without anyone asking for it again", async () => {
      let n = 0;
      let whole = false;
      const series = new WarmSeries<string>("Gold history", async () => (++n, whole ? { value: "whole", ttlMs: 60_000 } : { value: "gappy", ttlMs: 45_000, complete: false }), { partialAllowedAt: () => 0 });
      await expect(series.get(2500)).resolves.toBe("gappy"); // published at once, flagged
      expect(series.incomplete).toBe(true);
      expect(n).toBe(1);
      // Nobody asks again. It still retries once per lifetime of the gappy value: no faster, no slower.
      await vi.advanceTimersByTimeAsync(44_000);
      expect(n).toBe(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(n).toBe(2);
      await vi.advanceTimersByTimeAsync(45_000 * 3);
      expect(n).toBe(5);
      whole = true; // the missing files arrive
      await vi.advanceTimersByTimeAsync(45_000);
      expect(series.incomplete).toBe(false);
      expect(series.peek()).toBe("whole");
      const builds = n;
      await vi.advanceTimersByTimeAsync(10 * 60_000); // a whole value is left alone until someone needs it
      expect(n).toBe(builds);
    });

    it("keeps trying to complete a gappy value when a rebuild itself fails", async () => {
      let n = 0;
      let mode: "gappy" | "broken" | "whole" = "gappy";
      const series = new WarmSeries<string>("Gold history", async () => {
        n++;
        if (mode === "broken") throw new Error("archive unreachable");
        return mode === "whole" ? { value: "whole", ttlMs: 60_000 } : { value: "gappy", ttlMs: 45_000, complete: false };
      }, { partialAllowedAt: () => 0, retryAfterFailureMs: 30_000 });
      await series.get(2500);
      mode = "broken";
      await vi.advanceTimersByTimeAsync(46_000);
      expect(n).toBe(2);
      expect(series.peek()).toBe("gappy"); // the last value stays
      expect(series.lastError?.message).toBe("archive unreachable");
      mode = "whole";
      await vi.advanceTimersByTimeAsync(31_000);
      expect(series.peek()).toBe("whole");
      expect(series.incomplete).toBe(false);
      series.dispose();
    });

    it("keeps a refreshed series usable when a new file is missing, and says so", async () => {
      let n = 0;
      const series = new WarmSeries<string>("Gold history", async () => (++n === 1 ? { value: "v1", ttlMs: 1000 } : { value: "v2 without the newest hour", ttlMs: 45_000, complete: false }), { partialAllowedAt: () => Infinity });
      await expect(series.get(2500)).resolves.toBe("v1");
      await vi.advanceTimersByTimeAsync(1001);
      await series.get(2500);
      await expect(series.get(2500)).resolves.toBe("v2 without the newest hour");
      expect(series.incomplete).toBe(true);
    });
  });
});

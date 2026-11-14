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
    }, 30_000);
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
});

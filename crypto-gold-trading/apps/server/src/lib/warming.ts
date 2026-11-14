/**
 * "Not ready yet" is different from "failed".
 *
 * On a machine that has never run the terminal, spot-gold and FX history must be downloaded once from a
 * slow archive (minutes). Request handlers never wait for that download: they wait a short moment, then
 * throw WarmingError. The API answers "202 Accepted" with `warming: true` (the request is fine, the data
 * is still being prepared), the UI keeps its loading state and asks again, and nothing is replaced by
 * demo data in the meantime.
 */
export class WarmingError extends Error {
  readonly warming = true as const;
  constructor(message: string) {
    super(message);
    this.name = "WarmingError";
  }
}

export function isWarming(err: unknown): err is WarmingError {
  return err instanceof WarmingError || (typeof err === "object" && err !== null && (err as { warming?: unknown }).warming === true);
}

/**
 * "Not available right now" is a third state, different from "failed" and from "still downloading": the
 * source is known to be out (the price archive has delivered nothing of a metal's history although the
 * patience window is over). The API answers "202 Accepted" with `unavailable: true` and the reason (it
 * keeps trying in the background). The data is never replaced by demo data, and whoever detects the
 * condition logs it once: not every request that runs into it.
 */
export class UnavailableError extends Error {
  readonly unavailable = true as const;
  constructor(message: string) {
    super(message);
    this.name = "UnavailableError";
  }
}

export function isUnavailable(err: unknown): err is UnavailableError {
  return err instanceof UnavailableError || (typeof err === "object" && err !== null && (err as { unavailable?: unknown }).unavailable === true);
}

export type Settled<T> = { done: true; value: T } | { done: false };

/**
 * Waits up to `ms` for the promise. A rejection inside the window is rethrown; after the window the
 * promise simply keeps running. `Infinity` waits for the result.
 */
export function within<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  if (!Number.isFinite(ms)) return promise.then((value) => ({ done: true, value }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ done: false }), Math.max(0, ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ done: true, value });
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface Loaded<T> {
  value: T;
  /** How long this value may be served before a refresh is attempted. */
  ttlMs: number;
  /** False when the value has known gaps because some downloads failed. Defaults to true. */
  complete?: boolean;
}

export interface WarmSeriesOptions {
  /** After a failed refresh the previous value is served for this long before trying again. */
  retryAfterFailureMs?: number;
  /** How long a caller waits for a refresh when a previous value exists. */
  staleWaitMs?: number;
  /**
   * A first value that has gaps is held back until this time while the missing parts are retried;
   * callers keep getting WarmingError meanwhile. Infinity means a gappy first value is never published.
   * Defaults to "publish immediately".
   */
  partialAllowedAt?: () => number;
  /** How often a held-back first load is rebuilt. */
  rebuildMs?: number;
}

/**
 * A cached series with these guarantees:
 *  - a fresh value is returned immediately;
 *  - an expired value is refreshed by a single shared load; callers wait only briefly for it and
 *    otherwise get the previous value, so a slow refresh never delays a response;
 *  - with no value at all the caller waits at most `waitMs`, then gets WarmingError while the first
 *    load continues, so a later call finds it done;
 *  - a first value with gaps is not served as if it were whole: it is rebuilt on a timer until it is
 *    complete, or published flagged `incomplete` once `partialAllowedAt` has passed;
 *  - a value that was published with gaps keeps being rebuilt in the background until it is whole,
 *    whether or not anyone asks for it again (so "incomplete" never outlives the missing parts).
 */
export class WarmSeries<T> {
  private value: T | undefined;
  private expiresAt = 0;
  private inflight: Promise<void> | null = null;
  private waiters = new Set<{ resolve: (value: T) => void; reject: (err: unknown) => void }>();
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending background rebuild of a value that was published with gaps. */
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  private nextBuildAt = 0;
  private readonly retryAfterFailureMs: number;
  private readonly staleWaitMs: number;
  private readonly partialAllowedAt: () => number;
  private readonly rebuildMs: number;
  /** The value being served has known gaps. */
  incomplete = false;
  lastError: { at: number; message: string } | null = null;

  constructor(
    private readonly describe: string,
    private readonly loader: () => Promise<Loaded<T>>,
    options: WarmSeriesOptions = {},
  ) {
    this.retryAfterFailureMs = options.retryAfterFailureMs ?? 30_000;
    this.staleWaitMs = options.staleWaitMs ?? 500;
    this.partialAllowedAt = options.partialAllowedAt ?? (() => 0);
    this.rebuildMs = options.rebuildMs ?? 10_000;
  }

  /** The current value, fresh or stale, without triggering a load. */
  peek(): T | undefined {
    return this.value;
  }
  get ready(): boolean {
    return this.value !== undefined;
  }
  get loading(): boolean {
    return this.inflight !== null || this.rebuildTimer !== null;
  }

  /** Cancels pending rebuild timers (tests and shutdown). */
  dispose() {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    if (this.completionTimer) clearTimeout(this.completionTimer);
    this.completionTimer = null;
  }

  /** Rebuilds a value that is being served with gaps once its lifetime is over, without waiting for a caller. */
  private completeLater(ms: number) {
    if (this.completionTimer) clearTimeout(this.completionTimer);
    this.completionTimer = setTimeout(() => {
      this.completionTimer = null;
      if (this.incomplete) this.startBuild();
    }, Math.max(1000, ms));
    (this.completionTimer as { unref?: () => void }).unref?.();
  }

  private publish(loaded: Loaded<T>, complete: boolean) {
    this.value = loaded.value;
    this.incomplete = !complete;
    this.expiresAt = Date.now() + loaded.ttlMs;
    this.dispose();
    if (!complete) this.completeLater(loaded.ttlMs);
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const w of waiting) w.resolve(loaded.value);
  }

  private startBuild() {
    if (this.inflight) return;
    const build: Promise<void> = this.loader()
      .then(
        (loaded) => {
          this.lastError = null;
          const complete = loaded.complete !== false;
          if (complete || this.value !== undefined || Date.now() >= this.partialAllowedAt()) {
            this.publish(loaded, complete);
            return;
          }
          // A first value with gaps: hold it back and try again shortly (the downloader paces the real retries).
          this.nextBuildAt = Date.now() + this.rebuildMs;
          if (!this.rebuildTimer) {
            this.rebuildTimer = setTimeout(() => {
              this.rebuildTimer = null;
              if (this.value === undefined) this.startBuild();
            }, this.rebuildMs);
            (this.rebuildTimer as { unref?: () => void }).unref?.();
          }
        },
        (err: unknown) => {
          this.lastError = { at: Date.now(), message: err instanceof Error ? err.message : String(err) };
          if (this.value !== undefined) this.expiresAt = Date.now() + this.retryAfterFailureMs;
          if (this.value !== undefined && this.incomplete) this.completeLater(this.retryAfterFailureMs);
          const waiting = [...this.waiters];
          this.waiters.clear();
          for (const w of waiting) w.reject(err);
        },
      )
      .finally(() => {
        if (this.inflight === build) this.inflight = null;
      });
    this.inflight = build;
  }

  async get(waitMs: number): Promise<T> {
    if (this.value !== undefined && this.expiresAt > Date.now()) return this.value;
    if (this.value !== undefined) {
      // Expired: one shared refresh; this caller waits only briefly for it, then takes whatever is current.
      this.startBuild();
      if (this.inflight) await within(this.inflight, Math.min(waitMs, this.staleWaitMs));
      return this.value;
    }
    // Nothing to serve yet: wait for the first value to be published.
    const waiter = { resolve: (_: T) => {}, reject: (_: unknown) => {} };
    const published = new Promise<T>((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    published.catch(() => undefined);
    this.waiters.add(waiter);
    if (!this.inflight && !this.rebuildTimer && Date.now() >= this.nextBuildAt) this.startBuild();
    try {
      const outcome = await within(published, waitMs);
      if (outcome.done) return outcome.value;
    } finally {
      this.waiters.delete(waiter);
    }
    throw new WarmingError(`${this.describe} is being downloaded for the first time on this machine. It is cached afterwards.`);
  }
}

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
}

/**
 * A cached series with three guarantees:
 *  - a fresh value is returned immediately;
 *  - an expired value is refreshed by a single shared load; callers wait only briefly (`staleWaitMs`)
 *    for it and otherwise get the previous value, so a slow refresh never delays a response;
 *  - with no value at all the caller waits at most `waitMs`, then gets WarmingError while the first
 *    load continues, so the next call finds it done.
 */
export class WarmSeries<T> {
  private value: T | undefined;
  private expiresAt = 0;
  private inflight: Promise<T> | null = null;
  lastError: { at: number; message: string } | null = null;

  constructor(
    private readonly describe: string,
    private readonly loader: () => Promise<Loaded<T>>,
    /** After a failed refresh the previous value is served for this long before trying again. */
    private readonly retryAfterFailureMs = 30_000,
    /** How long a caller waits for a refresh when a previous value exists. */
    private readonly staleWaitMs = 500,
  ) {}

  /** The current value, fresh or stale, without triggering a load. */
  peek(): T | undefined {
    return this.value;
  }
  get ready(): boolean {
    return this.value !== undefined;
  }
  get loading(): boolean {
    return this.inflight !== null;
  }

  async get(waitMs: number): Promise<T> {
    if (this.value !== undefined && this.expiresAt > Date.now()) return this.value;
    if (!this.inflight) {
      const p = this.loader().then(
        (loaded) => {
          this.value = loaded.value;
          this.expiresAt = Date.now() + loaded.ttlMs;
          this.lastError = null;
          return loaded.value;
        },
        (err: unknown) => {
          this.lastError = { at: Date.now(), message: err instanceof Error ? err.message : String(err) };
          if (this.value !== undefined) this.expiresAt = Date.now() + this.retryAfterFailureMs;
          throw err;
        },
      );
      this.inflight = p;
      p.catch(() => undefined).finally(() => {
        if (this.inflight === p) this.inflight = null;
      });
    }
    try {
      const outcome = await within(this.inflight, this.value !== undefined ? Math.min(waitMs, this.staleWaitMs) : waitMs);
      if (outcome.done) return outcome.value;
    } catch (err) {
      if (this.value !== undefined) return this.value; // refresh failed: keep serving the last good series
      throw err;
    }
    if (this.value !== undefined) return this.value; // refresh still running: serve the previous series
    throw new WarmingError(`${this.describe} is being downloaded for the first time on this machine. It is cached afterwards.`);
  }
}

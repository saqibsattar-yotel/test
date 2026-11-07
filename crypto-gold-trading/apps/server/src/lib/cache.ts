/**
 * In-memory TTL cache with stale-while-error semantics: when a refresh fails, the
 * last good value is returned flagged as stale so the UI can warn instead of breaking.
 */
export interface CacheEntry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
}

export interface CachedResult<T> {
  value: T;
  fromCache: boolean;
  stale: boolean; // served past expiry because refresh failed
  storedAt: number;
  error?: string;
}

export class TtlCache {
  private entries = new Map<string, CacheEntry<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();

  get<T>(key: string): CacheEntry<T> | undefined {
    return this.entries.get(key) as CacheEntry<T> | undefined;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    const now = Date.now();
    this.entries.set(key, { value, storedAt: now, expiresAt: now + ttlMs });
  }

  delete(key: string) {
    this.entries.delete(key);
  }

  /**
   * Returns the cached value when fresh; otherwise calls `loader`. Concurrent callers
   * share one in-flight request. On loader failure the stale value (if any) is returned
   * with `stale: true` and the error message.
   */
  async getOrLoad<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<CachedResult<T>> {
    const now = Date.now();
    const existing = this.entries.get(key) as CacheEntry<T> | undefined;
    if (existing && existing.expiresAt > now) return { value: existing.value, fromCache: true, stale: false, storedAt: existing.storedAt };
    let p = this.inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = loader().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    try {
      const value = await p;
      this.set(key, value, ttlMs);
      return { value, fromCache: false, stale: false, storedAt: Date.now() };
    } catch (err) {
      if (existing) return { value: existing.value, fromCache: true, stale: true, storedAt: existing.storedAt, error: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  stats() {
    return { entries: this.entries.size, inflight: this.inflight.size };
  }
}

export const cache = new TtlCache();

import { logger } from "./logger";

const log = logger("http");
const UA = "CryptoGoldTerminal/0.1 (+research terminal; contact via repository)";

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly url: string, message: string, public readonly body?: string) {
    super(message);
  }
}

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** Treat these statuses as retryable (default 429, 5xx). */
  retryOn?: (status: number) => boolean;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json, text/xml, application/xml, text/plain, */*", ...opts.headers }, signal: ctrl.signal, redirect: "follow" });
      const text = await res.text();
      if (!res.ok) {
        const retryable = opts.retryOn ? opts.retryOn(res.status) : res.status === 429 || res.status >= 500;
        if (retryable && attempt < retries) {
          const backoff = 400 * Math.pow(2, attempt) + Math.random() * 200;
          log.warn(`HTTP ${res.status} from ${url} — retrying in ${Math.round(backoff)}ms`);
          await sleep(backoff);
          continue;
        }
        throw new HttpError(res.status, url, `HTTP ${res.status} for ${url}`, text.slice(0, 300));
      }
      return text;
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError) throw err;
      if (attempt < retries) {
        await sleep(300 * Math.pow(2, attempt));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Request failed: ${url}`);
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 120)}`);
  }
}

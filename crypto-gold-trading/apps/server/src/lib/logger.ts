type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
// Read at log time, not import time: the root .env is loaded by config.ts, which may be evaluated later.
const threshold = () => order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (order[level] < threshold()) return;
  const ts = new Date().toISOString();
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra !== undefined) console.log(line, typeof extra === "object" ? JSON.stringify(extra).slice(0, 500) : extra);
  else console.log(line);
}

const lastReported = new Map<string, number>();

/**
 * Runs `write` the first time a condition is seen and then at most once per `everyMs` while it lasts.
 * For failures that every request would otherwise report again: one line says it, the rest is noise.
 */
export function reportOnce(key: string, write: () => void, everyMs = 5 * 60_000): void {
  const now = Date.now();
  const last = lastReported.get(key);
  if (last !== undefined && now - last < everyMs) return;
  // The map only ever holds one entry per distinct condition; old ones are dropped when it grows.
  if (lastReported.size > 2000) for (const [k, t] of lastReported) if (now - t > everyMs) lastReported.delete(k);
  lastReported.set(key, now);
  write();
}

/** Forgets a condition, so that its next occurrence is reported straight away (it ended and came back). */
export function clearReported(key: string): void {
  lastReported.delete(key);
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit("debug", scope, m, e),
    info: (m: string, e?: unknown) => emit("info", scope, m, e),
    warn: (m: string, e?: unknown) => emit("warn", scope, m, e),
    error: (m: string, e?: unknown) => emit("error", scope, m, e instanceof Error ? e.message : e),
  };
}

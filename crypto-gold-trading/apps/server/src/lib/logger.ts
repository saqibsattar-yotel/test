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

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit("debug", scope, m, e),
    info: (m: string, e?: unknown) => emit("info", scope, m, e),
    warn: (m: string, e?: unknown) => emit("warn", scope, m, e),
    error: (m: string, e?: unknown) => emit("error", scope, m, e instanceof Error ? e.message : e),
  };
}

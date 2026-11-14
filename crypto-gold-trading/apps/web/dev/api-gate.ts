/**
 * Dev-only helpers for the Vite server.
 *
 * Problem: Vite is ready in ~200 ms, while the API server (tsx) needs a few seconds to boot and restarts
 * whenever its source or the root .env changes. Every /api request made in that window used to be
 * proxied to a closed port and failed with "http proxy error … ECONNREFUSED" (a 500 in the browser).
 *
 * The gate holds /api requests until the API accepts connections, then lets the normal proxy run.
 * If the API stays down past the wait budget, requests fail fast with a clear 503 until it is back.
 */
import net from "node:net";
import path from "node:path";
import { createLogger, loadEnv, type Connect, type Logger, type Plugin } from "vite";

export interface ApiTarget {
  host: string;
  port: number;
}

/**
 * Where the API server listens, from the same root env files the server reads
 * (real environment variables > .env.local > .env; see apps/server/src/lib/env.ts).
 */
export function resolveApiTarget(repoRoot: string, env: Record<string, string | undefined> = loadEnv("root", repoRoot, "")): ApiTarget {
  const port = Number.parseInt(env.PORT ?? "", 10);
  const raw = (env.HOST ?? "").trim().replace(/^\[|\]$/g, "") || "127.0.0.1";
  // A wildcard bind address is not a connect address: use loopback.
  const host = raw === "0.0.0.0" || raw === "::" ? "127.0.0.1" : raw;
  return { host, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8787 };
}

/** host:port for URLs (IPv6 literals need brackets). */
export const targetAuthority = (t: ApiTarget) => `${t.host.includes(":") ? `[${t.host}]` : t.host}:${t.port}`;

/** True when something accepts TCP connections on the target. */
export function probePort(target: ApiTarget, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: target.host, port: target.port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export interface ApiGateOptions {
  target: ApiTarget;
  /** How long requests are held while the API boots before they fail fast. */
  maxWaitMs?: number;
  /** Probe interval while waiting. */
  pollMs?: number;
  probe?: (target: ApiTarget) => Promise<boolean>;
  log?: (message: string) => void;
}

export function createApiGate(options: ApiGateOptions) {
  const { target } = options;
  const maxWaitMs = options.maxWaitMs ?? 20_000;
  const pollMs = options.pollMs ?? 150;
  const probeTarget = options.probe ?? probePort;
  const log = options.log ?? (() => undefined);
  const where = targetAuthority(target);

  interface Outage {
    since: number;
    recovered: Promise<void>;
    recover: () => void;
    warned: boolean;
  }
  let disposed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let outage: Outage | null = null;
  let probing: Promise<boolean> | null = null;

  /**
   * Every request is checked against the live port (a loopback connect costs a fraction of a millisecond),
   * so nothing is forwarded to a server that has just gone away. Concurrent requests share one probe.
   */
  const probe = (): Promise<boolean> => {
    probing ??= probeTarget(target).finally(() => {
      probing = null;
    });
    return probing;
  };

  const markUp = () => {
    const ended = outage;
    if (!ended) return;
    outage = null;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    log(`API server is up on ${where} (after ${((Date.now() - ended.since) / 1000).toFixed(1)} s)`);
    ended.recover();
  };

  /** One background poller per outage; every held request waits on the same promise. */
  const beginOutage = (): Outage => {
    if (outage) return outage;
    let recover!: () => void;
    const recovered = new Promise<void>((resolve) => (recover = resolve));
    const current: Outage = { since: Date.now(), recovered, recover, warned: false };
    outage = current;
    log(`waiting for the API server on ${where} …`);
    const tick = async () => {
      pollTimer = null;
      if (disposed || outage !== current) return;
      const up = await probe();
      if (disposed || outage !== current) return; // a request's own probe already ended this outage
      if (up) return markUp();
      const waited = Date.now() - current.since;
      if (!current.warned && waited >= maxWaitMs) {
        current.warned = true;
        log(`API server still unreachable on ${where} after ${Math.round(maxWaitMs / 1000)} s; /api requests fail fast until it is back`);
      }
      pollTimer = setTimeout(() => void tick(), waited < maxWaitMs ? pollMs : 1000);
    };
    pollTimer = setTimeout(() => void tick(), pollMs);
    return current;
  };

  /** Resolves true as soon as the API accepts connections, false when it stays down past the wait budget. */
  const ready = async (): Promise<boolean> => {
    const budgetSpent = outage !== null && Date.now() - outage.since >= maxWaitMs;
    if (!outage || budgetSpent) {
      // No known outage, or one that outlived its budget: a direct probe decides immediately.
      if (await probe()) {
        markUp();
        return true;
      }
      if (outage && Date.now() - outage.since >= maxWaitMs) return false;
    }
    const current = outage ?? beginOutage();
    const remaining = current.since + maxWaitMs - Date.now();
    if (remaining <= 0) return false;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), remaining);
      void current.recovered.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  };

  const isApiRequest = (url: string | undefined) => !!url && /^\/api(?:[/?]|$)/.test(url);

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (!isApiRequest(req.url)) return next();
    void ready().then((up) => {
      if (req.socket?.destroyed) return; // the browser gave up while waiting
      if (up) return next();
      if (res.headersSent || res.writableEnded) return;
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Retry-After", "2");
      res.end(JSON.stringify({ error: `The API server is not reachable on ${where}. Start it with "npm run dev" and check PORT/HOST in .env.` }));
    });
  };

  const dispose = () => {
    disposed = true;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  };

  return { middleware, ready, dispose };
}

/** Vite plugin: gates /api behind API readiness and follows PORT/HOST edits in the root env files. */
export function apiGate(target: ApiTarget, opts: { repoRoot?: string; gate?: Partial<ApiGateOptions> } = {}): Plugin {
  return {
    name: "terminal:api-gate",
    apply: "serve",
    configureServer(server) {
      const info = (message: string) => server.config.logger.info(`[api] ${message}`, { timestamp: true });
      const gate = createApiGate({ ...opts.gate, target, log: info });
      server.middlewares.use(gate.middleware);
      server.httpServer?.once("close", gate.dispose);

      const root = opts.repoRoot;
      if (!root) return;
      // The proxy target is read from the root env files: restart Vite when PORT or HOST change there.
      const files = [".env", ".env.local"].map((name) => path.join(root, name));
      server.watcher.add(files);
      const onEnvChange = (file: string) => {
        if (!files.includes(path.normalize(file))) return;
        const next = resolveApiTarget(root);
        if (next.host === target.host && next.port === target.port) return;
        info(`API address changed to ${targetAuthority(next)}; restarting the dev server`);
        void server.restart();
      };
      server.watcher.on("change", onEnvChange).on("add", onEnvChange).on("unlink", onEnvChange);
    },
  };
}

const ANSI = /\u001b\[[0-9;]*m/g;
const TRANSIENT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE"]);

/**
 * Vite prints every proxy failure as a red multi-line stack trace. Two kinds are routine in development
 * and carry no stack worth reading: the API server dropping a connection because it is restarting, and
 * a browser tab going away while a WebSocket frame is being written. For those this returns a one-line
 * description; for anything else it returns null and the original error is printed untouched.
 */
export function describeTransientProxyError(message: string, error?: { code?: string; message?: string } | null): string | null {
  if (!error) return null;
  const match = /^(http|ws) proxy (socket )?error:?[ \t]*([^\n]*)/.exec(message.replace(ANSI, ""));
  if (!match) return null;
  const hangUp = /socket hang up/i.test(error.message ?? "");
  if (!TRANSIENT_CODES.has(error.code ?? "") && !hangUp) return null;
  const reason = error.code || "socket hang up";
  if (match[1] === "ws" && match[2]) return `a browser WebSocket went away mid-write (${reason}); normal when a tab reloads or closes`;
  const subject = match[1] === "ws" ? "the WebSocket" : match[3].trim().startsWith("/") ? match[3].trim() : "a request";
  return `the API server closed the connection for ${subject} (${reason}); it is restarting or was stopped`;
}

/** Vite logger that turns the routine proxy disconnects above into single-line warnings. */
export function createDevLogger(): Logger {
  const logger = createLogger();
  const printError = logger.error.bind(logger);
  logger.error = (message, options) => {
    const brief = describeTransientProxyError(message, options?.error as { code?: string; message?: string } | null | undefined);
    if (brief) return logger.warn(`[api] ${brief}`, { timestamp: true });
    printError(message, options);
  };
  return logger;
}

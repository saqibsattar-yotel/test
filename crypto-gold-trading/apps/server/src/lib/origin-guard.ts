/**
 * Access control for a local, unauthenticated API.
 *
 * The server has no login, so the browser is the only thing standing between another website and the
 * user's journal, settings and monitors. This guard enforces "pages from this machine only":
 *
 *  1. Host header: must be a loopback name, an IP literal, or an explicitly allowed hostname. Rejecting
 *     unknown DNS names stops DNS rebinding (a hostile domain re-pointed at 127.0.0.1 would otherwise
 *     look same-origin to the browser).
 *  2. Origin header (browsers send it on cross-origin requests, on every non-GET request and on
 *     WebSocket handshakes): must be a loopback origin on any port (the Vite dev server), the server's
 *     own origin, or an origin listed in ALLOWED_ORIGINS.
 *  3. No Origin, but Sec-Fetch-Site: cross-site on an API path (another site's <img>, <script> or
 *     no-cors fetch): rejected, unless it is a top-level navigation.
 *
 * Non-browser clients (curl, scripts, health checks) send none of these headers and are unaffected.
 */
import net from "node:net";
import type { FastifyInstance } from "fastify";

export interface OriginPolicy {
  /** Extra allowed origins, normalised as "scheme://host[:port]". */
  origins: Set<string>;
  /** Hostnames accepted in the Host header besides loopback names and IP literals. */
  hosts: Set<string>;
  /** Entries of ALLOWED_ORIGINS that could not be parsed. */
  invalid: string[];
}

export type GuardVerdict = { ok: true } | { ok: false; reason: string };

const stripBrackets = (h: string) => h.replace(/^\[|\]$/g, "");

/** "localhost", "*.localhost", 127.0.0.0/8 and ::1. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = stripBrackets(hostname.toLowerCase());
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

const isIpLiteral = (hostname: string) => net.isIP(stripBrackets(hostname)) !== 0;

/** Hostname part of a Host header ("example.com:8787" → "example.com", "[::1]:8787" → "::1"). */
export function hostnameOf(hostHeader: string): string | null {
  const value = hostHeader.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(1, end) : null;
  }
  const colon = value.lastIndexOf(":");
  // More than one colon without brackets is a bare IPv6 literal, not host:port.
  if (colon > 0 && value.indexOf(":") === colon) return value.slice(0, colon);
  return value;
}

/**
 * Parses ALLOWED_ORIGINS (comma or whitespace separated). Entries are origins such as
 * "http://192.168.1.20:5173" or "https://terminal.example.com"; a bare "host[:port]" means http.
 * A specific hostname in HOST (not a wildcard, IP or loopback name) is accepted in the Host header too.
 */
export function parseAllowedOrigins(raw: string | undefined, bindHost?: string): OriginPolicy {
  const policy: OriginPolicy = { origins: new Set(), hosts: new Set(), invalid: [] };
  for (const entry of (raw ?? "").split(/[\s,]+/).filter(Boolean)) {
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ? entry : `http://${entry}`);
      const hostname = stripBrackets(url.hostname.toLowerCase());
      // Exact origins only: no paths, no wildcards, no credentials.
      const validHost = isIpLiteral(hostname) || /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || !validHost || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("not an origin");
      policy.origins.add(url.origin.toLowerCase());
      policy.hosts.add(stripBrackets(url.hostname.toLowerCase()));
    } catch {
      policy.invalid.push(entry);
    }
  }
  const bind = stripBrackets((bindHost ?? "").trim().toLowerCase());
  if (bind && bind !== "0.0.0.0" && bind !== "::" && !isIpLiteral(bind) && !isLoopbackHostname(bind)) policy.hosts.add(bind);
  return policy;
}

/** True when a browser page with this Origin may call the API. */
export function isAllowedOrigin(origin: string | undefined, hostHeader: string | undefined, policy: OriginPolicy): boolean {
  if (origin === undefined) return true; // not a cross-origin browser request
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // includes the literal "null" origin (sandboxed frames, file:// pages)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (isLoopbackHostname(url.hostname)) return true;
  if (hostHeader && url.host.toLowerCase() === hostHeader.trim().toLowerCase()) return true; // the server's own origin
  return policy.origins.has(url.origin.toLowerCase());
}

const isApiPath = (path: string) => /^\/(?:api|ws)(?:[/?]|$)/.test(path);

export function checkRequest(req: { host?: string; origin?: string; secFetchSite?: string; secFetchMode?: string; path: string }, policy: OriginPolicy): GuardVerdict {
  if (req.host !== undefined) {
    const hostname = hostnameOf(req.host);
    if (!hostname || !(isLoopbackHostname(hostname) || isIpLiteral(hostname) || policy.hosts.has(hostname))) {
      return { ok: false, reason: `Host "${req.host}" is not allowed. This API only answers on localhost, on its IP address, or on hosts listed in ALLOWED_ORIGINS.` };
    }
  }
  if (req.origin !== undefined) {
    if (isAllowedOrigin(req.origin, req.host, policy)) return { ok: true };
    return { ok: false, reason: `Origin "${req.origin}" is not allowed to use this API. Only pages served from this machine may call it; add the origin to ALLOWED_ORIGINS in .env to permit it.` };
  }
  if (req.secFetchSite === "cross-site" && req.secFetchMode !== "navigate" && isApiPath(req.path)) {
    return { ok: false, reason: "Cross-site requests to this API are not allowed." };
  }
  return { ok: true };
}

const single = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(", ") : value);

/**
 * Installs the guard as an onRequest hook (it also runs for WebSocket handshakes, which Fastify routes
 * like any other request). Register it before CORS so rejected preflights never get CORS headers.
 */
export function registerOriginGuard(app: FastifyInstance, policy: OriginPolicy, onReject?: (reason: string) => void) {
  const reported = new Set<string>();
  app.addHook("onRequest", async (request, reply) => {
    const verdict = checkRequest(
      { host: single(request.headers.host), origin: single(request.headers.origin), secFetchSite: single(request.headers["sec-fetch-site"]), secFetchMode: single(request.headers["sec-fetch-mode"]), path: request.url },
      policy,
    );
    if (verdict.ok) return;
    if (onReject && reported.size < 50 && !reported.has(verdict.reason)) {
      reported.add(verdict.reason);
      onReject(verdict.reason);
    }
    if (request.headers.upgrade !== undefined) {
      // A refused WebSocket handshake: Node has already detached this socket from the HTTP server, so
      // nothing else would ever close it. Destroy it once the 403 has been written.
      const socket = request.raw.socket;
      reply.header("Connection", "close");
      reply.raw.once("finish", () => socket.destroy());
    }
    return reply.code(403).header("Cache-Control", "no-store").send({ error: verdict.reason });
  });
}

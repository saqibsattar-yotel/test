import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { buildServer } from "../src/server";
import { parseAllowedOrigins } from "../src/lib/origin-guard";

const LOCAL = "http://localhost:5173";
const FOREIGN = "https://evil.example";

describe("API access control (real server, default policy: this machine only)", () => {
  let app: FastifyInstance;
  let port: number;
  beforeAll(async () => {
    app = await buildServer({ originPolicy: parseAllowedOrigins("") });
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await app.close();
  });

  it("serves non-browser clients and local pages, with CORS headers only for the local origin", async () => {
    const plain = await app.inject({ method: "GET", url: "/api/features" });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers["access-control-allow-origin"]).toBeUndefined();
    const local = await app.inject({ method: "GET", url: "/api/features", headers: { origin: LOCAL } });
    expect(local.statusCode).toBe(200);
    expect(local.headers["access-control-allow-origin"]).toBe(LOCAL);
  });

  it("refuses reads from another website and sends it no CORS headers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/journal", headers: { origin: FOREIGN } });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.json().error).toContain("ALLOWED_ORIGINS");
  });

  it("refuses writes and preflights from another website before any route runs", async () => {
    const post = await app.inject({ method: "POST", url: "/api/monitor/does-not-exist/cancel", headers: { origin: FOREIGN, "content-type": "application/json" }, payload: "{}" });
    expect(post.statusCode).toBe(403); // a 404 here would mean the route handler ran
    const preflight = await app.inject({ method: "OPTIONS", url: "/api/journal/abc", headers: { origin: FOREIGN, "access-control-request-method": "DELETE" } });
    expect(preflight.statusCode).toBe(403);
    expect(preflight.headers["access-control-allow-methods"]).toBeUndefined();
    const localPreflight = await app.inject({ method: "OPTIONS", url: "/api/journal/abc", headers: { origin: LOCAL, "access-control-request-method": "DELETE" } });
    expect(localPreflight.statusCode).toBe(204);
    expect(localPreflight.headers["access-control-allow-origin"]).toBe(LOCAL);
  });

  it("refuses DNS rebinding (unknown name in Host) and cross-site subresource requests", async () => {
    const rebinding = await app.inject({ method: "GET", url: "/api/features", headers: { host: "evil.example:8787" } });
    expect(rebinding.statusCode).toBe(403);
    const sameOriginAfterRebinding = await app.inject({ method: "POST", url: "/api/backtest", headers: { host: "evil.example:8787", origin: "http://evil.example:8787", "content-type": "application/json" }, payload: "{}" });
    expect(sameOriginAfterRebinding.statusCode).toBe(403);
    const crossSiteImg = await app.inject({ method: "GET", url: "/api/features", headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } });
    expect(crossSiteImg.statusCode).toBe(403);
    const ownLanOrigin = await app.inject({ method: "GET", url: "/api/features", headers: { host: "192.168.1.20:8787", origin: "http://192.168.1.20:8787" } });
    expect(ownLanOrigin.statusCode).toBe(200); // the page this server itself serves on a LAN address
  });

  const handshake = (origin?: string) =>
    new Promise<{ opened: boolean; status?: number; first?: string }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
      ws.once("open", () => ws.once("message", (data) => (resolve({ opened: true, first: data.toString() }), ws.close())));
      ws.once("unexpected-response", (_req, res) => (resolve({ opened: false, status: res.statusCode }), ws.terminate()));
      ws.once("error", () => resolve({ opened: false }));
    });

  it("accepts WebSocket handshakes from local pages and scripts, and refuses other websites", async () => {
    const local = await handshake(LOCAL);
    expect(local.opened).toBe(true);
    expect(JSON.parse(local.first ?? "{}").type).toBe("status");
    expect((await handshake()).opened).toBe(true);
    expect(await handshake(FOREIGN)).toEqual({ opened: false, status: 403 });
  });

  it("does not leak the socket of a refused WebSocket handshake", async () => {
    const openConnections = () => new Promise<number>((resolve) => app.server.getConnections((_err, count) => resolve(count)));
    for (let i = 0; i < 5; i++) expect((await handshake(FOREIGN)).status).toBe(403);
    let open = await openConnections();
    for (let i = 0; i < 40 && open > 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      open = await openConnections();
    }
    expect(open).toBe(0);
  });
});

describe("API access control with ALLOWED_ORIGINS", () => {
  it("admits exactly the listed origins and host names", async () => {
    const app = await buildServer({ originPolicy: parseAllowedOrigins("http://192.168.1.20:5173, https://terminal.example.com") });
    try {
      const lanDev = await app.inject({ method: "GET", url: "/api/features", headers: { origin: "http://192.168.1.20:5173" } });
      expect(lanDev.statusCode).toBe(200);
      expect(lanDev.headers["access-control-allow-origin"]).toBe("http://192.168.1.20:5173");
      expect((await app.inject({ method: "GET", url: "/api/features", headers: { origin: "http://192.168.1.21:5173" } })).statusCode).toBe(403);
      const viaProxy = await app.inject({ method: "GET", url: "/api/features", headers: { host: "terminal.example.com", origin: "https://terminal.example.com" } });
      expect(viaProxy.statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/features", headers: { host: "other.example.com" } })).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

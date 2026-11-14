import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApiGate, describeTransientProxyError, probePort, resolveApiTarget, targetAuthority, type ApiTarget } from "../dev/api-gate";

const servers: net.Server[] = [];
function listen(port = 0): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      servers.push(server);
      resolve({ server, port: (server.address() as net.AddressInfo).port });
    });
  });
}
async function freePort(): Promise<number> {
  const { server, port } = await listen();
  await new Promise((r) => server.close(r));
  return port;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** Minimal req/res doubles: enough for the gate middleware. */
function call(gate: ReturnType<typeof createApiGate>, url: string) {
  const state = { next: false, status: 0, body: "", headers: {} as Record<string, string> };
  const req = { url, socket: { destroyed: false } } as unknown as IncomingMessage;
  const done = new Promise<typeof state>((resolve) => {
    const res = {
      headersSent: false,
      writableEnded: false,
      set statusCode(v: number) {
        state.status = v;
      },
      setHeader(k: string, v: string) {
        state.headers[k.toLowerCase()] = v;
      },
      end(body: string) {
        state.body = body;
        resolve(state);
      },
    } as unknown as ServerResponse;
    gate.middleware(req, res, () => {
      state.next = true;
      resolve(state);
    });
  });
  return done;
}

describe("API target resolution", () => {
  it("defaults to 127.0.0.1:8787 and follows PORT / HOST", () => {
    expect(resolveApiTarget("/unused", {})).toEqual({ host: "127.0.0.1", port: 8787 });
    expect(resolveApiTarget("/unused", { PORT: "9100", HOST: "192.168.1.20" })).toEqual({ host: "192.168.1.20", port: 9100 });
  });
  it("maps wildcard bind addresses to loopback and rejects invalid ports", () => {
    expect(resolveApiTarget("/unused", { HOST: "0.0.0.0", PORT: "9100" })).toEqual({ host: "127.0.0.1", port: 9100 });
    expect(resolveApiTarget("/unused", { HOST: "::" })).toEqual({ host: "127.0.0.1", port: 8787 });
    expect(resolveApiTarget("/unused", { PORT: "not-a-port" }).port).toBe(8787);
    expect(resolveApiTarget("/unused", { PORT: "70000" }).port).toBe(8787);
  });
  it("brackets IPv6 literals in URLs", () => {
    expect(targetAuthority({ host: "::1", port: 8787 })).toBe("[::1]:8787");
    expect(targetAuthority(resolveApiTarget("/unused", { HOST: "[::1]" }))).toBe("[::1]:8787");
    expect(targetAuthority({ host: "127.0.0.1", port: 8787 })).toBe("127.0.0.1:8787");
  });
});

describe("API gate", () => {
  it("probePort reports whether something is listening", async () => {
    const { port } = await listen();
    expect(await probePort({ host: "127.0.0.1", port })).toBe(true);
    expect(await probePort({ host: "127.0.0.1", port: await freePort() })).toBe(false);
  });

  it("passes non-API requests straight through without probing", async () => {
    let probes = 0;
    const gate = createApiGate({ target: { host: "127.0.0.1", port: 1 }, probe: async () => (probes++, false) });
    for (const url of ["/", "/src/main.tsx", "/apiary", "/ws"]) expect((await call(gate, url)).next).toBe(true);
    expect(probes).toBe(0);
    gate.dispose();
  });

  it("never forwards to a server that has just gone away, and shares one probe between concurrent requests", async () => {
    let up = true;
    let probes = 0;
    const gate = createApiGate({ target: { host: "127.0.0.1", port: 1 }, pollMs: 10, maxWaitMs: 60, probe: async () => (probes++, up) });
    const burst = await Promise.all(Array.from({ length: 20 }, () => call(gate, "/api/health")));
    expect(burst.every((r) => r.next)).toBe(true);
    expect(probes).toBe(1); // 20 concurrent requests → a single probe
    up = false; // the API dies: the very next request must not reach the proxy
    const after = await call(gate, "/api/health");
    expect(after.next).toBe(false);
    expect(after.status).toBe(503);
    gate.dispose();
  });

  it("lets API requests through when the server is up", async () => {
    const { port } = await listen();
    const gate = createApiGate({ target: { host: "127.0.0.1", port } });
    expect((await call(gate, "/api/health")).next).toBe(true);
    expect((await call(gate, "/api")).next).toBe(true);
    expect((await call(gate, "/api?x=1")).next).toBe(true);
    gate.dispose();
  });

  it("holds requests while the server boots and releases them once it listens", async () => {
    const port = await freePort();
    const target: ApiTarget = { host: "127.0.0.1", port };
    const logs: string[] = [];
    const gate = createApiGate({ target, pollMs: 20, maxWaitMs: 5000, log: (m) => logs.push(m) });
    const started = Date.now();
    const a = call(gate, "/api/monitor");
    const b = call(gate, "/api/market/quotes?assets=BTCUSD");
    setTimeout(() => void listen(port), 250);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.next).toBe(true);
    expect(rb.next).toBe(true);
    expect(ra.status).toBe(0); // proxied normally, no error response
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(logs.filter((l) => l.startsWith("waiting for the API server"))).toHaveLength(1); // one line per outage, not per request
    expect(logs.some((l) => l.startsWith("API server is up"))).toBe(true);
    gate.dispose();
  });

  it("answers 503 with a clear message when the server stays down, then fails fast", async () => {
    const port = await freePort();
    const logs: string[] = [];
    const gate = createApiGate({ target: { host: "127.0.0.1", port }, pollMs: 20, maxWaitMs: 150, log: (m) => logs.push(m) });
    const first = await call(gate, "/api/health");
    expect(first.next).toBe(false);
    expect(first.status).toBe(503);
    expect(first.headers["retry-after"]).toBe("2");
    expect(JSON.parse(first.body).error).toContain(`127.0.0.1:${port}`);
    const t = Date.now();
    const second = await call(gate, "/api/health"); // budget spent → immediate
    expect(second.status).toBe(503);
    expect(Date.now() - t).toBeLessThan(100);
    await new Promise((r) => setTimeout(r, 80)); // the first poll after the budget announces fail-fast mode once
    expect(logs.filter((l) => l.includes("still unreachable"))).toHaveLength(1);
    // …and the next request after the server appears goes straight through.
    await listen(port);
    expect((await call(gate, "/api/health")).next).toBe(true);
    expect(logs.filter((l) => l.startsWith("API server is up"))).toHaveLength(1);
    expect(logs.filter((l) => l.startsWith("waiting for the API server"))).toHaveLength(1);
    gate.dispose();
  });
});

describe("proxy log condensing", () => {
  const red = (text: string) => `\u001b[31m${text}\u001b[39m`;
  it("condenses an API restart during a request into one line", () => {
    const line = describeTransientProxyError(`${red("http proxy error: /api/overview")}\nError: socket hang up\n    at Socket.socketOnEnd`, { message: "socket hang up", code: "ECONNRESET" });
    expect(line).toBe("the API server closed the connection for /api/overview (ECONNRESET); it is restarting or was stopped");
    expect(describeTransientProxyError("http proxy error: /api/monitor\nError: connect ECONNREFUSED 127.0.0.1:8787", { message: "connect ECONNREFUSED 127.0.0.1:8787", code: "ECONNREFUSED" })).toContain("/api/monitor (ECONNREFUSED)");
    expect(describeTransientProxyError("http proxy error: /api/x\nError: socket hang up", { message: "socket hang up" })).toContain("(socket hang up)");
  });
  it("condenses a browser WebSocket that went away mid-write", () => {
    const line = describeTransientProxyError(`${red("ws proxy socket error:")}\nError: write EPIPE\n    at afterWriteDispatched`, { message: "write EPIPE", code: "EPIPE" });
    expect(line).toBe("a browser WebSocket went away mid-write (EPIPE); normal when a tab reloads or closes");
    expect(describeTransientProxyError("ws proxy error:\nError: read ECONNRESET", { message: "read ECONNRESET", code: "ECONNRESET" })).toContain("the WebSocket (ECONNRESET)");
  });
  it("leaves every other error untouched", () => {
    expect(describeTransientProxyError("http proxy error: /api/x\nError: getaddrinfo ENOTFOUND nope", { message: "getaddrinfo ENOTFOUND nope", code: "ENOTFOUND" })).toBeNull();
    expect(describeTransientProxyError("Internal server error: Failed to resolve import", { message: "Failed to resolve import", code: "ECONNRESET" })).toBeNull();
    expect(describeTransientProxyError("http proxy error: /api/x\nError: boom")).toBeNull();
  });
});

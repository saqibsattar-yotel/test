import { describe, it, expect } from "vitest";
import { checkRequest, hostnameOf, isAllowedOrigin, isLoopbackHostname, parseAllowedOrigins } from "../src/lib/origin-guard";

const none = parseAllowedOrigins("");

describe("origin policy parsing", () => {
  it("is empty by default", () => {
    expect(none.origins.size).toBe(0);
    expect(none.hosts.size).toBe(0);
    expect(none.invalid).toEqual([]);
  });
  it("normalises origins and collects their hostnames", () => {
    const p = parseAllowedOrigins("http://192.168.1.20:5173, https://Terminal.Example.com/  my-mac.local:8787");
    expect([...p.origins].sort()).toEqual(["http://192.168.1.20:5173", "http://my-mac.local:8787", "https://terminal.example.com"]);
    expect([...p.hosts].sort()).toEqual(["192.168.1.20", "my-mac.local", "terminal.example.com"]);
    expect(p.invalid).toEqual([]);
  });
  it("reports entries that are not origins instead of guessing", () => {
    const p = parseAllowedOrigins("ftp://files.example.com, https://ok.example.com, https://a.example.com/some/path, *");
    expect([...p.origins]).toEqual(["https://ok.example.com"]);
    expect(p.invalid).toEqual(["ftp://files.example.com", "https://a.example.com/some/path", "*"]);
  });
  it("accepts a specific HOST name in the Host header, but not wildcards, IPs or loopback names", () => {
    expect([...parseAllowedOrigins("", "terminal.lan").hosts]).toEqual(["terminal.lan"]);
    for (const bind of ["0.0.0.0", "::", "127.0.0.1", "192.168.1.5", "localhost", ""]) expect(parseAllowedOrigins("", bind).hosts.size).toBe(0);
  });
});

describe("host and origin helpers", () => {
  it("extracts hostnames from Host headers", () => {
    expect(hostnameOf("localhost:8787")).toBe("localhost");
    expect(hostnameOf("127.0.0.1")).toBe("127.0.0.1");
    expect(hostnameOf("[::1]:8787")).toBe("::1");
    expect(hostnameOf("::1")).toBe("::1");
    expect(hostnameOf("Example.COM:443")).toBe("example.com");
    expect(hostnameOf("")).toBeNull();
  });
  it("recognises loopback names", () => {
    for (const h of ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]"]) expect(isLoopbackHostname(h)).toBe(true);
    for (const h of ["localhost.evil.example", "evil-localhost", "128.0.0.1", "192.168.1.5", "1270.0.0.1", "example.com"]) expect(isLoopbackHostname(h)).toBe(false);
  });
  it("allows loopback origins on any port, the server's own origin, and listed origins only", () => {
    expect(isAllowedOrigin(undefined, "127.0.0.1:8787", none)).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173", "127.0.0.1:8787", none)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:8787", "127.0.0.1:8787", none)).toBe(true);
    expect(isAllowedOrigin("http://[::1]:5174", "127.0.0.1:8787", none)).toBe(true);
    expect(isAllowedOrigin("http://192.168.1.20:8787", "192.168.1.20:8787", none)).toBe(true); // served by this server on the LAN
    expect(isAllowedOrigin("http://192.168.1.20:3000", "192.168.1.20:8787", none)).toBe(false); // another app on that machine
    expect(isAllowedOrigin("https://evil.example", "127.0.0.1:8787", none)).toBe(false);
    expect(isAllowedOrigin("http://localhost.evil.example", "127.0.0.1:8787", none)).toBe(false);
    expect(isAllowedOrigin("null", "127.0.0.1:8787", none)).toBe(false);
    expect(isAllowedOrigin("file://", "127.0.0.1:8787", none)).toBe(false);
    expect(isAllowedOrigin("chrome-extension://abcdef", "127.0.0.1:8787", none)).toBe(false);
    expect(isAllowedOrigin("https://evil.example, http://localhost:5173", "127.0.0.1:8787", none)).toBe(false);
    const p = parseAllowedOrigins("http://192.168.1.20:5173");
    expect(isAllowedOrigin("http://192.168.1.20:5173", "127.0.0.1:8787", p)).toBe(true);
    expect(isAllowedOrigin("http://192.168.1.20:5174", "127.0.0.1:8787", p)).toBe(false);
    expect(isAllowedOrigin("https://192.168.1.20:5173", "127.0.0.1:8787", p)).toBe(false);
  });
});

describe("request guard", () => {
  const ok = { ok: true };
  it("lets non-browser clients and local pages through", () => {
    expect(checkRequest({ path: "/api/health" }, none)).toEqual(ok); // HTTP/1.0 client without Host
    expect(checkRequest({ host: "127.0.0.1:8787", path: "/api/health" }, none)).toEqual(ok); // curl
    expect(checkRequest({ host: "localhost:8787", secFetchSite: "same-origin", path: "/api/journal" }, none)).toEqual(ok); // same-origin GET
    expect(checkRequest({ host: "127.0.0.1:8787", origin: "http://localhost:5173", secFetchSite: "same-origin", path: "/api/journal" }, none)).toEqual(ok); // Vite proxy
    expect(checkRequest({ host: "localhost:5173", origin: "http://localhost:5173", path: "/ws" }, none)).toEqual(ok); // proxied WebSocket handshake
    expect(checkRequest({ host: "localhost:8787", secFetchSite: "none", path: "/api/health" }, none)).toEqual(ok); // typed into the address bar
  });
  it("rejects other websites: CORS reads, writes and WebSocket handshakes", () => {
    for (const path of ["/api/journal", "/api/monitor/abc/cancel", "/ws", "/"]) {
      const v = checkRequest({ host: "127.0.0.1:8787", origin: "https://evil.example", secFetchSite: "cross-site", path }, none);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toContain("https://evil.example");
    }
    expect(checkRequest({ host: "127.0.0.1:8787", origin: "null", path: "/api/journal" }, none).ok).toBe(false);
  });
  it("rejects DNS rebinding: an unknown DNS name in Host, even when Origin matches it", () => {
    expect(checkRequest({ host: "evil.example:8787", path: "/api/journal" }, none).ok).toBe(false);
    expect(checkRequest({ host: "evil.example:8787", origin: "http://evil.example:8787", secFetchSite: "same-origin", path: "/api/journal" }, none).ok).toBe(false);
    expect(checkRequest({ host: "192.168.1.20:8787", path: "/api/journal" }, none)).toEqual(ok); // IP literals cannot be rebound
    expect(checkRequest({ host: "my-mac.local:8787", path: "/api/journal" }, parseAllowedOrigins("http://my-mac.local:8787"))).toEqual(ok);
  });
  it("rejects cross-site subresource requests without an Origin, but not navigations or static files", () => {
    expect(checkRequest({ host: "localhost:8787", secFetchSite: "cross-site", secFetchMode: "no-cors", path: "/api/setups?assets=XAUUSD" }, none).ok).toBe(false);
    expect(checkRequest({ host: "localhost:8787", secFetchSite: "cross-site", secFetchMode: "navigate", path: "/api/health" }, none)).toEqual(ok);
    expect(checkRequest({ host: "localhost:8787", secFetchSite: "cross-site", secFetchMode: "navigate", path: "/" }, none)).toEqual(ok);
    expect(checkRequest({ host: "localhost:8787", secFetchSite: "cross-site", secFetchMode: "no-cors", path: "/assets/index.js" }, none)).toEqual(ok);
    expect(checkRequest({ host: "localhost:8787", secFetchSite: "same-site", secFetchMode: "no-cors", path: "/api/health" }, none)).toEqual(ok);
  });
});

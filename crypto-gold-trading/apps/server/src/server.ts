import fs from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { config, featureFlags, loadedEnvFiles, repoRoot } from "./config";
import { logger } from "./lib/logger";
import { isAllowedOrigin, registerOriginGuard, type OriginPolicy } from "./lib/origin-guard";
import { isWarming } from "./lib/warming";
import { cache } from "./lib/cache";
import { marketRoutes } from "./routes/market";
import { analysisRoutes } from "./routes/analysis";
import { contentRoutes } from "./routes/content";
import { riskRoutes } from "./routes/risk";
import { journalRoutes } from "./routes/journal";
import { userRoutes } from "./routes/user";
import { aiRoutes } from "./routes/ai";
import { assetRoutes } from "./routes/assets";
import { monitorRoutes } from "./routes/monitor";
import { backtestRoutes } from "./routes/backtest";
import { assets } from "./services/assets";
import { monitor } from "./services/monitor";
import { liveSampler, getGoldVerification, getDxy, getInstrumentCandles, getWarmupStatus, prewarm as prewarmGold } from "./services/gold";
import { market } from "./services/market";
import { hub } from "./ws/hub";
import { liquidations } from "./services/liquidations";
import { alerts } from "./services/alerts";

const log = logger("server");

export async function buildServer(opts: { originPolicy?: OriginPolicy } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024, forceCloseConnections: true });
  // Installed before any route: Fastify binds the error handler to a route when the route is defined, so a
  // handler set afterwards would never be used (responses would fall back to Fastify's generic format).
  app.setErrorHandler((err, _req, reply) => {
    if (isWarming(err)) {
      // Not a failure: the data is still being downloaded for the first time. "202 Accepted" tells the UI to keep
      // loading and ask again, without the browser logging an error for every poll.
      return reply.code(202).header("Retry-After", "5").header("Cache-Control", "no-store").send({ warming: true, error: (err as Error).message });
    }
    log.error("request failed", err);
    reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ error: (err as Error).message ?? "internal error" });
  });

  // The API has no login: only pages served from this machine (or origins listed in ALLOWED_ORIGINS) may
  // call it. The guard runs first, for HTTP requests and WebSocket handshakes alike; CORS headers are then
  // granted to exactly the origins the guard lets through.
  const originPolicy = opts.originPolicy ?? config.originPolicy;
  // Hook order matters: the WebSocket plugin first (it marks upgrade requests so their sockets are cleaned
  // up), then the guard, then CORS (so a refused preflight never receives CORS headers).
  await app.register(websocket);
  registerOriginGuard(app, originPolicy, (reason) => log.warn(`blocked request: ${reason}`));
  await app.register(cors, { delegator: (req, callback) => callback(null, { origin: req.headers.origin !== undefined && isAllowedOrigin(req.headers.origin, req.headers.host, originPolicy) }) });

  app.get("/api/health", async () => ({ ok: true, time: Date.now(), cache: cache.stats(), upstream: hub.status(), features: featureFlags() }));
  app.get("/api/features", async () => featureFlags());
  // Progress of the one-time history download on a machine that has never run the terminal.
  app.get("/api/status/warmup", async () => getWarmupStatus());
  app.get("/api/market/gold/verification", async () => getGoldVerification());
  app.get("/api/market/dxy", async () => {
    const d = await getDxy();
    return { value: d.value, ts: d.ts, quality: d.quality, source: d.source, components: d.components, archiveLastClose: d.archiveLastClose, computedVsArchivePct: d.computedVsArchivePct, history1h: d.history1h.slice(-300), history1d: d.history1d.slice(-400), warming: d.historyWarming };
  });
  app.get("/api/market/gold/instruments", async () => {
    const [spot, paxg, dukaDaily] = await Promise.allSettled([market.getQuotes(["XAUUSD"]), market.getQuotes(["PAXGUSD"]), getInstrumentCandles("XAUUSD", "1d", 2)]);
    const liveSamplerState = { lastSampleAt: liveSampler.lastSampleAt, lastError: liveSampler.lastError };
    const s = spot.status === "fulfilled" ? spot.value[0] : null;
    const p = paxg.status === "fulfilled" ? paxg.value[0] : null;
    const prev = dukaDaily.status === "fulfilled" && dukaDaily.value.length ? dukaDaily.value[dukaDaily.value.length - 1] : null;
    return {
      spot: s ? { quote: s, kind: "Spot XAU/USD (OTC, London/global interbank)", tradesWhen: "Sunday ~22:00 UTC to Friday ~22:00 UTC with a daily break around 22:00 UTC" } : null,
      tokenized: p ? { quote: p, kind: "PAX Gold (PAXG) — ERC-20 token backed by vaulted gold, traded on crypto venues 24/7", premiumVsSpotPct: s ? ((p.price - s.price) / s.price) * 100 : null } : null,
      futures: { kind: "COMEX gold futures (GC) — 100 troy oz, $0.10 tick = $10; MGC micro 10 oz", quote: null, note: "Live GC quotes need a licensed futures feed (e.g. a Twelve Data/CME-enabled plan). Contract specifications are available in the Risk Calculator; no price is fabricated here." },
      archiveLastDaily: prev,
      sampler: liveSamplerState,
      warming: (spot.status === "fulfilled" && !s) || (dukaDaily.status === "rejected" && isWarming(dukaDaily.reason)),
    };
  });

  await app.register(marketRoutes);
  await app.register(analysisRoutes);
  await app.register(contentRoutes);
  await app.register(riskRoutes);
  await app.register(journalRoutes);
  await app.register(userRoutes);
  await app.register(aiRoutes);
  await app.register(assetRoutes);
  await app.register(monitorRoutes);
  await app.register(backtestRoutes);

  app.get("/ws", { websocket: true }, (socket) => {
    hub.addClient(socket as unknown as { send: (d: string) => void; readyState: number });
    socket.on("close", () => hub.removeClient(socket as unknown as { send: (d: string) => void; readyState: number }));
    socket.on("message", (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; assets?: unknown };
        if (msg.type === "subscribe" && Array.isArray(msg.assets)) hub.ensureSubscribed(msg.assets.filter((a): a is string => typeof a === "string" && assets.isSupported(a.toUpperCase())).map((a) => a.toUpperCase()).slice(0, 50));
      } catch {
        /* ignore malformed client messages */
      }
    });
  });

  // Serve the built web app when present (production mode).
  const dist = fs.existsSync(config.webDist) ? config.webDist : null;
  if (dist) {
    await app.register(fastifyStatic, { root: dist, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
    log.info(`serving web app from ${dist}`);
  }

  return app;
}

async function main() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const app = await buildServer();
  assets.start();
  liveSampler.start();
  setTimeout(() => void prewarmGold(), 1000);
  hub.start();
  liquidations.start();
  alerts.start();
  monitor.start();
  await app.listen({ port: config.PORT, host: config.HOST });
  log.info(`listening on http://${config.HOST}:${config.PORT}  (demo mode: ${config.DEMO_MODE}; AI: ${config.hasAnthropic ? config.ANTHROPIC_MODEL : "rule-based"}; gold: ${config.hasTwelveData ? "Twelve Data + Dukascopy/Swissquote" : "Dukascopy archive + Swissquote live"})`);
  log.info(`environment: ${loadedEnvFiles.length ? loadedEnvFiles.join(" + ") : "no .env file found, using defaults"} (read from ${repoRoot})`);
  const extraOrigins = [...config.originPolicy.origins];
  log.info(`access: browser requests are accepted from this machine only${extraOrigins.length ? `, plus ${extraOrigins.join(", ")}` : ""}`);
  if (config.originPolicy.invalid.length) log.warn(`ALLOWED_ORIGINS: ignored ${config.originPolicy.invalid.map((e) => `"${e}"`).join(", ")} (expected origins such as http://192.168.1.20:5173)`);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    assets.stop();
    liveSampler.stop();
    hub.stop();
    alerts.stop();
    monitor.stop();
    // Never hang on draining sockets: force exit after a short grace period.
    setTimeout(() => process.exit(0), 3000).unref();
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain = process.argv[1] && (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"));
if (isMain) main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});

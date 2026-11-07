import fs from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { config, featureFlags } from "./config";
import { logger } from "./lib/logger";
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
import { liveSampler, getGoldVerification, getDxy, getInstrumentCandles, prewarm as prewarmGold } from "./services/gold";
import { market } from "./services/market";
import { hub } from "./ws/hub";
import { liquidations } from "./services/liquidations";
import { alerts } from "./services/alerts";

const log = logger("server");

export async function buildServer() {
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024, forceCloseConnections: true });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.get("/api/health", async () => ({ ok: true, time: Date.now(), cache: cache.stats(), upstream: hub.status(), features: featureFlags() }));
  app.get("/api/features", async () => featureFlags());
  app.get("/api/market/gold/verification", async () => getGoldVerification());
  app.get("/api/market/dxy", async () => {
    const d = await getDxy();
    return { value: d.value, ts: d.ts, quality: d.quality, source: d.source, components: d.components, archiveLastClose: d.archiveLastClose, computedVsArchivePct: d.computedVsArchivePct, history1h: d.history1h.slice(-300), history1d: d.history1d.slice(-400) };
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

  app.setErrorHandler((err, _req, reply) => {
    log.error("request failed", err);
    reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ error: (err as Error).message ?? "internal error" });
  });
  return app;
}

async function main() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const app = await buildServer();
  assets.start();
  liveSampler.start();
  setTimeout(() => void prewarmGold(), 4000);
  hub.start();
  liquidations.start();
  alerts.start();
  monitor.start();
  await app.listen({ port: config.PORT, host: config.HOST });
  log.info(`listening on http://${config.HOST}:${config.PORT}  (demo mode: ${config.DEMO_MODE}; AI: ${config.hasAnthropic ? config.ANTHROPIC_MODEL : "rule-based"}; gold: ${config.hasTwelveData ? "Twelve Data + Dukascopy/Swissquote" : "Dukascopy archive + Swissquote live"})`);
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

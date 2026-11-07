import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CRYPTO_ASSETS, TIMEFRAMES, type AssetId, type Timeframe } from "@terminal/core";
import { market, CANDLE_LIMITS } from "../services/market";
import { liquidations } from "../services/liquidations";
import { assets } from "../services/assets";
import { hub } from "../ws/hub";

const tfSchema = z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]]);

export function parseAssets(raw: unknown, fallback: AssetId[]): AssetId[] {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const ids = raw.split(",").map((s) => s.trim().toUpperCase()).filter((s) => assets.isSupported(s));
  return ids.length ? ids : fallback;
}

export async function marketRoutes(app: FastifyInstance) {
  app.get("/api/market/quotes", async (req) => {
    const q = req.query as { assets?: string };
    const ids = parseAssets(q.assets, [...CRYPTO_ASSETS, "XAUUSD"]);
    hub.ensureSubscribed(ids);
    return { quotes: await market.getQuotes(ids), generatedAt: Date.now() };
  });

  app.get("/api/market/candles/:assetId", async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    const q = req.query as { tf?: string; limit?: string };
    if (!assets.isSupported(assetId.toUpperCase())) return reply.code(404).send({ error: "unknown asset" });
    const tf = tfSchema.safeParse(q.tf ?? "4h");
    if (!tf.success) return reply.code(400).send({ error: "invalid timeframe" });
    hub.ensureSubscribed([assetId.toUpperCase()]);
    const limit = Math.min(1000, Math.max(50, parseInt(q.limit ?? String(CANDLE_LIMITS[tf.data]), 10) || CANDLE_LIMITS[tf.data]));
    return market.getCandles(assetId.toUpperCase() as AssetId, tf.data, limit);
  });

  app.get("/api/market/global", async () => market.getGlobal());
  app.get("/api/market/sentiment", async () => market.getFearGreed());
  app.get("/api/market/top-coins", async () => market.getTopCoins());
  app.get("/api/market/funding", async (req) => {
    const q = req.query as { assets?: string };
    return market.getFunding(parseAssets(q.assets, CRYPTO_ASSETS));
  });
  app.get("/api/market/open-interest/:assetId", async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    if (!assets.isSupported(assetId.toUpperCase())) return reply.code(404).send({ error: "unknown asset" });
    return market.getOpenInterest(assetId.toUpperCase() as AssetId);
  });
  app.get("/api/market/liquidations", async (req) => {
    const q = req.query as { hours?: string };
    const hours = Math.min(24, Math.max(1, parseFloat(q.hours ?? "24") || 24));
    return liquidations.summary(hours * 3_600_000);
  });
  app.get("/api/market/macro", async () => market.getMacro());
}

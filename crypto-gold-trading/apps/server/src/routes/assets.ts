import type { FastifyInstance } from "fastify";
import { assets } from "../services/assets";

export async function assetRoutes(app: FastifyInstance) {
  app.get("/api/assets", async (req) => {
    const q = req.query as { q?: string; limit?: string };
    const limit = Math.min(1000, Math.max(1, parseInt(q.limit ?? "600", 10) || 600));
    const list = q.q ? assets.search(q.q, limit) : assets.list(limit);
    return { assets: list, total: assets.size(), loaded: assets.loaded, loadedAt: assets.loadedAt, note: "Universe = Binance USDT spot pairs currently trading (excluding fiat, stablecoin and leveraged products) + XAU/USD. Names and ranks from CoinGecko top-250 where available." };
  });
  app.get("/api/assets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const upper = id.toUpperCase();
    if (!assets.isSupported(upper)) return reply.code(404).send({ error: "unknown asset" });
    return { asset: assets.get(upper) ?? assets.meta(upper) };
  });
}

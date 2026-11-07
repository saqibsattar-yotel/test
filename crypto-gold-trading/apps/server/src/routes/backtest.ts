import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashString, TIMEFRAMES, type Timeframe } from "@terminal/core";
import { cache } from "../lib/cache";
import { runBacktestInWorker } from "../lib/backtest-runner";
import { market } from "../services/market";
import { assets } from "../services/assets";

const body = z.object({
  assetId: z.string(),
  timeframe: z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]]).default("4h"),
  bars: z.number().int().min(300).max(3000).default(1500),
  feesBps: z.number().min(0).max(200).default(5),
  slippageBps: z.number().min(0).max(100).default(3),
  riskPct: z.number().min(0.1).max(10).default(1),
  startingEquity: z.number().positive().default(10_000),
  exitModel: z.enum(["tp1", "tp2", "tp3", "ladder"]).default("ladder"),
  maxPendingBars: z.number().int().min(1).max(30).default(6),
  minQuality: z.number().min(0).max(100).default(60),
  splitPct: z.number().min(0.5).max(0.9).default(0.7),
  stepBars: z.number().int().min(1).max(10).default(1),
  allowLongs: z.boolean().default(true),
  allowShorts: z.boolean().default(true),
});

export async function backtestRoutes(app: FastifyInstance) {
  app.post("/api/backtest", async (req, reply) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body", issues: parsed.error.issues });
    const cfg = parsed.data;
    const id = cfg.assetId.toUpperCase();
    if (!assets.isSupported(id)) return reply.code(404).send({ error: "unknown asset" });
    const key = `backtest:${hashString(JSON.stringify({ ...cfg, assetId: id }))}`;
    const res = await cache.getOrLoad(key, 10 * 60_000, async () => {
      const data = await market.getCandlesExtended(id, cfg.timeframe, cfg.bars);
      if (data.source.quality === "demo") throw new Error("Backtesting refuses demo data — live history is unavailable for this asset right now.");
      // Runs in a worker thread so quotes, monitors and other requests are not blocked by the simulation.
      const result = await runBacktestInWorker(data.candles, { ...cfg, assetId: id, warmupBars: Math.min(260, Math.floor(data.candles.length * 0.3)) });
      return { result, source: data.source, warnings: data.warnings };
    });
    return res.value;
  });
}

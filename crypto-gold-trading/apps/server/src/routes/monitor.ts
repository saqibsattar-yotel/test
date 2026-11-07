import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TIMEFRAMES, type Timeframe, type TradeSetup } from "@terminal/core";
import { monitor } from "../services/monitor";
import { getSetup } from "../services/analysis";
import { getSettings } from "../services/user";
import { assets } from "../services/assets";

/** The subset of a TradeSetup the monitor relies on; anything else is passed through untouched. */
const monitoredSetupSchema = z
  .object({
    id: z.string().min(1),
    assetId: z.string().min(3),
    symbol: z.string().min(1),
    status: z.string(),
    direction: z.enum(["LONG", "SHORT"]).nullable(),
    timeframe: z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]]),
    entry: z.object({ low: z.number().positive(), high: z.number().positive(), mid: z.number().positive() }),
    stopLoss: z.number().positive().nullable(),
    targets: z.array(z.object({ label: z.string(), price: z.number().positive(), rMultiple: z.number(), basis: z.string().optional() })).min(3),
    expiresAt: z.number(),
  })
  .passthrough();

export async function monitorRoutes(app: FastifyInstance) {
  app.get("/api/monitor", async () => ({ ...(await monitor.list()), note: "Levels are monitored against streamed prices. Reaching a level is recorded as an event; no order is ever placed or assumed." }));

  app.post("/api/monitor", async (req, reply) => {
    const body = z.object({ setup: z.custom<TradeSetup>((v) => monitoredSetupSchema.safeParse(v).success, "setup must carry id, asset, direction, entry zone, stop, three targets with R multiples and an expiry").optional(), assetId: z.string().optional(), timeframe: z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]]).optional(), source: z.enum(["saved", "manual"]).default("saved") }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid body", issues: body.error.issues.map((i) => i.message) });
    let setup = body.data.setup ?? null;
    if (!setup) {
      const id = body.data.assetId?.toUpperCase();
      if (!id || !assets.isSupported(id)) return reply.code(400).send({ error: "assetId required" });
      const settings = await getSettings();
      const res = await getSetup(id, body.data.timeframe ?? settings.defaultTimeframe, { accountBalance: settings.accountBalance, riskPct: settings.defaultRiskPct });
      setup = res.primary;
    }
    if (setup.status === "NO TRADE" || !setup.direction || setup.stopLoss === null) return reply.code(422).send({ error: "This setup is NO TRADE or has no stop; nothing to monitor." });
    try {
      const { item, created } = await monitor.track(setup, body.data.source);
      return reply.code(created ? 201 : 200).send({ item, created });
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message });
    }
  });

  app.post("/api/monitor/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = await monitor.cancel(id);
    if (!item) return reply.code(404).send({ error: "not found" });
    return { item };
  });
  app.post("/api/monitor/:id/close", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ price: z.number().positive().optional() }).safeParse(req.body ?? {});
    const item = await monitor.close(id, body.success ? body.data.price : undefined);
    if (!item) return reply.code(404).send({ error: "not found" });
    return { item };
  });
  app.delete("/api/monitor/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await monitor.remove(id);
    if (!ok) return reply.code(404).send({ error: "not found or still active (cancel it first)" });
    return { ok: true };
  });
}

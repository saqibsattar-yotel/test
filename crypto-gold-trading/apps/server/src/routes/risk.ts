import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { INSTRUMENT_KINDS, INSTRUMENT_SPECS, METALS, evaluateCircuitBreaker, evaluateDisciplineGate, isMetalAsset, portfolioHeat, sizePosition, type InstrumentKind, type InstrumentSpec, isAssetId, type AssetId } from "@terminal/core";
import { market } from "../services/market";
import { getSettings, journalStore } from "../services/user";
import { getCryptoRegime, getMetalRegime } from "../services/analysis";

const customSpec = z.object({
  id: z.string().default("custom"),
  kind: z.enum(INSTRUMENT_KINDS as [InstrumentKind, ...InstrumentKind[]]),
  label: z.string().default("Custom instrument"),
  contractSize: z.number().positive(),
  baseUnit: z.string().default("units"),
  quantityUnit: z.string().default("units"),
  tickSize: z.number().nonnegative().default(0.01),
  qtyStep: z.number().positive().default(0.01),
  minQty: z.number().nonnegative().default(0),
  minNotional: z.number().optional(),
  maxLeverage: z.number().optional(),
  maintenanceMarginRate: z.number().optional(),
  hardTickGrid: z.boolean().default(false),
});

const sizeBody = z.object({
  accountBalance: z.number(),
  accountCurrency: z.string().default("USD"),
  riskPct: z.number(),
  direction: z.enum(["LONG", "SHORT"]),
  entry: z.number(),
  stop: z.number(),
  takeProfit: z.number().nullable().optional(),
  leverage: z.number().nullable().optional(),
  specId: z.string().optional(),
  customSpec: customSpec.optional(),
  fxQuoteToAccount: z.number().positive().optional(),
});

const gateBody = z.object({
  entryInWrittenPlan: z.boolean().nullable(),
  stopPredefined: z.boolean().nullable(),
  sizeWithinPlan: z.boolean().nullable(),
  plannedRiskAmount: z.number().nullable(),
  actualRiskAmount: z.number().nullable(),
  assetId: z.string().optional(),
  direction: z.enum(["LONG", "SHORT"]).nullable().optional(),
  revengeWindowHours: z.number().optional(),
});

export async function riskRoutes(app: FastifyInstance) {
  app.get("/api/risk/instruments", async (req) => {
    const q = req.query as { refresh?: string };
    const specs = Object.values(INSTRUMENT_SPECS);
    if (q.refresh === "1") {
      for (const s of specs.filter((x) => x.kind === "crypto_spot")) {
        const asset = s.id.replace("binance-spot-", "").replace("USDT", "USD");
        if (isAssetId(asset)) {
          const f = await market.getExchangeFilters(asset as AssetId);
          if (f) Object.assign(s, { tickSize: f.tickSize, qtyStep: f.stepSize, minQty: f.minQty, minNotional: f.minNotional, verified: new Date().toISOString().slice(0, 10) });
        }
      }
    }
    return { instruments: specs };
  });

  app.post("/api/risk/size", async (req, reply) => {
    const parsed = sizeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body", issues: parsed.error.issues });
    const b = parsed.data;
    const spec: InstrumentSpec | undefined = b.customSpec ? { ...b.customSpec, quoteCurrency: "USD", source: "User supplied", note: "Custom specification entered by the user — verify against your broker/exchange." } : INSTRUMENT_SPECS[b.specId ?? "binance-spot-BTCUSDT"];
    if (!spec) return reply.code(400).send({ error: "unknown instrument spec" });
    const result = sizePosition({ accountBalance: b.accountBalance, accountCurrency: b.accountCurrency, riskPct: b.riskPct, direction: b.direction, entry: b.entry, stop: b.stop, takeProfit: b.takeProfit ?? null, leverage: b.leverage ?? null, spec, fxQuoteToAccount: b.fxQuoteToAccount });
    return { result, spec };
  });

  app.get("/api/risk/circuit-breaker", async () => {
    const settings = await getSettings();
    const journal = await journalStore.load();
    const closed = journal.trades.filter((t) => t.status === "closed" && !t.isTestData && t.realizedPnl !== null && t.closedAt).map((t) => ({ closedAt: t.closedAt as number, realizedPnl: t.realizedPnl as number }));
    const open = journal.trades.filter((t) => t.status === "open" && !t.isTestData).map((t) => t.riskAmount);
    return { circuitBreaker: evaluateCircuitBreaker(closed, settings.accountBalance, Date.now(), { maxDailyLossPct: 2, losingStreakN: 2, cooldownHours: 24, weeklyDrawdownPct: 5, monthlyDrawdownPct: 8, zone: settings.timezone || "UTC" }), heat: portfolioHeat(open, settings.accountBalance) };
  });

  app.post("/api/risk/gate", async (req, reply) => {
    const parsed = gateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body", issues: parsed.error.issues });
    const b = parsed.data;
    const settings = await getSettings();
    const journal = await journalStore.load();
    const closed = journal.trades.filter((t) => t.status === "closed" && !t.isTestData && t.realizedPnl !== null && t.closedAt).map((t) => ({ closedAt: t.closedAt as number, realizedPnl: t.realizedPnl as number }));
    const cb = evaluateCircuitBreaker(closed, settings.accountBalance, Date.now(), { maxDailyLossPct: 2, losingStreakN: 2, cooldownHours: 24, weeklyDrawdownPct: 5, monthlyDrawdownPct: 8, zone: settings.timezone || "UTC" });
    let regime: { zone: string; direction: "LONG" | "SHORT" | null } | null = null;
    try {
      if (b.assetId && isMetalAsset(b.assetId)) regime = { zone: (await getMetalRegime(METALS[b.assetId].metal)).result.zone, direction: b.direction ?? null };
      else if (b.assetId) regime = { zone: (await getCryptoRegime()).result.zone, direction: b.direction ?? null };
    } catch {
      regime = null;
    }
    const gate = evaluateDisciplineGate({ entryInWrittenPlan: b.entryInWrittenPlan, stopPredefined: b.stopPredefined, sizeWithinPlan: b.sizeWithinPlan, plannedRiskAmount: b.plannedRiskAmount, actualRiskAmount: b.actualRiskAmount, recentClosedTrades: closed, revengeWindowHours: b.revengeWindowHours, marketRegime: b.assetId ? regime : undefined, circuitBreaker: cb, now: Date.now() });
    return { gate, circuitBreaker: cb };
  });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ASSETS, closeTrade, computePerformance, filterTrades, hashString, TIMEFRAMES, type AssetId, type JournalTrade, type Timeframe } from "@terminal/core";
import { assets } from "../services/assets";
const isAssetId = (v: string) => assets.isSupported(v.toUpperCase());
import { getSettings, journalStore } from "../services/user";

const tradeBody = z.object({
  assetId: z.string().refine(isAssetId),
  direction: z.enum(["LONG", "SHORT"]),
  setupType: z.string().default("other"),
  timeframe: z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]]),
  entry: z.number().positive(),
  stop: z.number().positive(),
  takeProfit: z.number().positive().nullable().optional(),
  quantity: z.number().positive(),
  quantityUnit: z.string().default("units"),
  riskPct: z.number().nonnegative(),
  riskAmount: z.number().nonnegative(),
  entryReasoning: z.string().default(""),
  screenshots: z.array(z.string().max(2_500_000)).max(6).default([]),
  openedAt: z.number().optional(),
  tags: z.array(z.string()).default([]),
  source: z.enum(["manual", "setup", "paper"]).default("manual"),
  isTestData: z.boolean().default(false),
  setupId: z.string().optional(),
  mistakes: z.string().default(""),
  lessons: z.string().default(""),
});

const closeBody = z.object({
  exitPrice: z.number().positive(),
  exitAt: z.number().optional(),
  realizedPnl: z.number().nullable().optional(),
  contractSize: z.number().positive().optional(),
  fxQuoteToAccount: z.number().positive().optional(),
  mistakes: z.string().optional(),
  lessons: z.string().optional(),
  mae: z.number().nullable().optional(),
  mfe: z.number().nullable().optional(),
});

function parseFilter(q: Record<string, string | undefined>) {
  return {
    assetId: (q.asset && isAssetId(q.asset) ? q.asset : "all") as AssetId | "all",
    assetClass: (q.class === "crypto" || q.class === "gold" ? q.class : "all") as "crypto" | "gold" | "all",
    timeframe: ((TIMEFRAMES as string[]).includes(q.tf ?? "") ? q.tf : "all") as Timeframe | "all",
    setupType: q.setup || "all",
    status: (q.status === "open" || q.status === "closed" ? q.status : "all") as "open" | "closed" | "all",
    from: q.from ? Date.parse(q.from) : null,
    to: q.to ? Date.parse(q.to) : null,
    includeTestData: q.test === "1",
  };
}

export async function journalRoutes(app: FastifyInstance) {
  app.get("/api/journal/trades", async (req) => {
    const j = await journalStore.load();
    const f = parseFilter(req.query as Record<string, string | undefined>);
    const trades = filterTrades(j.trades, f).sort((a, b) => b.openedAt - a.openedAt);
    return { trades, total: j.trades.length };
  });

  app.post("/api/journal/trades", async (req, reply) => {
    const parsed = tradeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid trade", issues: parsed.error.issues });
    const b = parsed.data;
    if (b.direction === "LONG" && b.stop >= b.entry) return reply.code(400).send({ error: "LONG stop must be below entry" });
    if (b.direction === "SHORT" && b.stop <= b.entry) return reply.code(400).send({ error: "SHORT stop must be above entry" });
    const now = Date.now();
    const meta = assets.meta(b.assetId as AssetId, b.entry);
    const trade: JournalTrade = {
      id: `tr_${hashString(`${b.assetId}${b.entry}${now}${Math.random()}`)}`,
      assetId: b.assetId as AssetId,
      assetClass: meta.assetClass,
      symbol: meta.symbol,
      direction: b.direction,
      setupType: b.setupType as JournalTrade["setupType"],
      timeframe: b.timeframe,
      entry: b.entry,
      stop: b.stop,
      takeProfit: b.takeProfit ?? null,
      quantity: b.quantity,
      quantityUnit: b.quantityUnit,
      riskPct: b.riskPct,
      riskAmount: b.riskAmount,
      entryReasoning: b.entryReasoning,
      screenshots: b.screenshots,
      exitPrice: null,
      exitAt: null,
      realizedPnl: null,
      rMultiple: null,
      mae: null,
      mfe: null,
      mistakes: b.mistakes,
      lessons: b.lessons,
      status: "open",
      openedAt: b.openedAt ?? now,
      closedAt: null,
      tags: b.tags,
      source: b.source,
      isTestData: b.isTestData,
      setupId: b.setupId,
      createdAt: now,
      updatedAt: now,
    };
    await journalStore.update((j) => ({ trades: [trade, ...j.trades] }));
    return reply.code(201).send({ trade });
  });

  app.patch("/api/journal/trades/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = (req.body ?? {}) as Partial<JournalTrade>;
    const allowed: (keyof JournalTrade)[] = ["entryReasoning", "mistakes", "lessons", "tags", "screenshots", "takeProfit", "stop", "isTestData", "mae", "mfe"];
    let updated: JournalTrade | null = null;
    await journalStore.update((j) => {
      const t = j.trades.find((x) => x.id === id);
      if (!t) return j;
      for (const k of allowed) if (k in patch) (t as unknown as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k];
      t.updatedAt = Date.now();
      updated = t;
      return j;
    });
    if (!updated) return reply.code(404).send({ error: "trade not found" });
    return { trade: updated };
  });

  app.post("/api/journal/trades/:id/close", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = closeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid close", issues: parsed.error.issues });
    let closed: JournalTrade | null = null;
    let err: string | null = null;
    await journalStore.update((j) => {
      const idx = j.trades.findIndex((x) => x.id === id);
      if (idx === -1) {
        err = "trade not found";
        return j;
      }
      if (j.trades[idx].status === "closed") {
        err = "trade already closed";
        return j;
      }
      closed = closeTrade(j.trades[idx], { ...parsed.data, exitAt: parsed.data.exitAt ?? Date.now() });
      j.trades[idx] = closed;
      return j;
    });
    if (err) return reply.code(err === "trade not found" ? 404 : 409).send({ error: err });
    return { trade: closed };
  });

  app.delete("/api/journal/trades/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    let removed = false;
    await journalStore.update((j) => {
      const before = j.trades.length;
      j.trades = j.trades.filter((t) => t.id !== id);
      removed = j.trades.length < before;
      return j;
    });
    if (!removed) return reply.code(404).send({ error: "trade not found" });
    return { ok: true };
  });

  app.get("/api/journal/stats", async (req) => {
    const j = await journalStore.load();
    const settings = await getSettings();
    const f = parseFilter(req.query as Record<string, string | undefined>);
    const trades = filterTrades(j.trades, { ...f, status: "all" });
    return { stats: computePerformance(trades, { includeTestData: f.includeTestData, startingBalance: settings.accountBalance, zone: settings.timezone }), filter: f, note: f.includeTestData ? "Includes explicitly labelled TEST data." : "Only real recorded trades are included." };
  });

  /** Seeds clearly labelled TEST trades so the analytics UI can be explored. */
  app.post("/api/journal/seed-test-data", async () => {
    const now = Date.now();
    const samples: Array<[AssetId, "LONG" | "SHORT", JournalTrade["setupType"], Timeframe, number, number, number, number, number]> = [
      ["BTCUSD", "LONG", "trend_pullback", "4h", 61200, 59800, 64000, 0.05, 63900],
      ["ETHUSD", "LONG", "breakout", "1h", 2410, 2350, 2550, 0.8, 2338],
      ["XAUUSD", "SHORT", "range_fade", "1h", 2662, 2674, 2630, 0.2, 2635],
      ["SOLUSD", "LONG", "liquidity_sweep_reversal", "15m", 141.2, 137.9, 149, 7, 148.5],
      ["BTCUSD", "SHORT", "breakdown", "4h", 58900, 60400, 55500, 0.04, 60450],
      ["XAUUSD", "LONG", "trend_pullback", "4h", 2602, 2581, 2660, 0.3, 2658],
      ["BNBUSD", "LONG", "mean_reversion", "1h", 561, 549, 590, 2, 574],
      ["XAUUSD", "LONG", "breakout", "1h", 2688, 2672, 2730, 0.2, 2671],
    ];
    const trades: JournalTrade[] = samples.map((s, i) => {
      const [assetId, direction, setupType, timeframe, entry, stop, tp, qty, exit] = s;
      const meta = ASSETS[assetId];
      const openedAt = now - (samples.length - i) * 3 * 86_400_000;
      const contractSize = assetId === "XAUUSD" ? 100 : 1;
      const base: JournalTrade = {
        id: `tr_test_${i}_${hashString(String(openedAt))}`,
        assetId,
        assetClass: meta.assetClass,
        symbol: meta.symbol,
        direction,
        setupType,
        timeframe,
        entry,
        stop,
        takeProfit: tp,
        quantity: qty,
        quantityUnit: assetId === "XAUUSD" ? "lots" : meta.base,
        riskPct: 1,
        riskAmount: Math.abs(entry - stop) * qty * contractSize,
        entryReasoning: "TEST DATA — illustrative trade for exploring the analytics UI.",
        screenshots: [],
        exitPrice: null,
        exitAt: null,
        realizedPnl: null,
        rMultiple: null,
        mae: null,
        mfe: null,
        mistakes: "",
        lessons: "",
        status: "open",
        openedAt,
        closedAt: null,
        tags: ["test"],
        source: "paper",
        isTestData: true,
        createdAt: openedAt,
        updatedAt: openedAt,
      };
      return closeTrade(base, { exitPrice: exit, exitAt: openedAt + 36 * 3_600_000, contractSize, lessons: "TEST DATA" });
    });
    await journalStore.update((j) => ({ trades: [...trades, ...j.trades.filter((t) => !t.isTestData)] }));
    return { seeded: trades.length };
  });

  app.delete("/api/journal/test-data", async () => {
    let removed = 0;
    await journalStore.update((j) => {
      const before = j.trades.length;
      j.trades = j.trades.filter((t) => !t.isTestData);
      removed = before - j.trades.length;
      return j;
    });
    return { removed };
  });
}

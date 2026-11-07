import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashString, isValidTimeZone, TIMEFRAMES, type AssetId, type Timeframe, type TradeSetup } from "@terminal/core";
import { assets } from "../services/assets";
const isAssetId = (v: string) => assets.isSupported(v.toUpperCase());
import { DEFAULT_SETTINGS, normalizeSettings, userStore, type AlertRule, type UserSettings } from "../services/user";

const settingsBody = z.object({
  timezone: z.string().refine(isValidTimeZone, "invalid IANA timezone").optional(),
  theme: z.enum(["dark", "light", "system"]).optional(),
  accountBalance: z.number().positive().optional(),
  accountCurrency: z.string().min(3).max(4).optional(),
  defaultRiskPct: z.number().positive().max(10).optional(),
  defaultTimeframe: z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]]).optional(),
  followedAssets: z.array(z.string().refine(isAssetId)).min(1).optional(),
  followedTimeframes: z.array(z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]])).min(1).optional(),
  onboardingComplete: z.boolean().optional(),
  dashboardLayout: z.array(z.string()).optional(),
  preferredInstrument: z.record(z.string()).optional(),
  autoMonitorSetups: z.boolean().optional(),
});

const alertBody = z.object({
  kind: z.enum(["price_above", "price_below", "setup_status", "regime_change"]),
  assetId: z.string().refine(isAssetId).nullable().default(null),
  timeframe: z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]]).optional(),
  level: z.number().positive().optional(),
  statuses: z.array(z.string()).optional(),
  note: z.string().max(200).optional(),
});

export async function userRoutes(app: FastifyInstance) {
  app.get("/api/user/settings", async () => ({ settings: normalizeSettings((await userStore.load()).settings) }));
  app.put("/api/user/settings", async (req, reply) => {
    const parsed = settingsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid settings", issues: parsed.error.issues });
    const state = await userStore.update((s) => ({ ...s, settings: normalizeSettings({ ...s.settings, ...(parsed.data as Partial<UserSettings>) }) }));
    return { settings: state.settings };
  });

  app.get("/api/user/watchlist", async () => {
    const s = await userStore.load();
    return { watchlist: s.watchlist, favorites: s.favorites };
  });
  app.put("/api/user/watchlist", async (req, reply) => {
    const body = z.object({ watchlist: z.array(z.string().refine(isAssetId)).optional(), favorites: z.array(z.string().refine(isAssetId)).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid watchlist" });
    const s = await userStore.update((st) => ({ ...st, watchlist: (body.data.watchlist as AssetId[] | undefined) ?? st.watchlist, favorites: (body.data.favorites as AssetId[] | undefined) ?? st.favorites }));
    return { watchlist: s.watchlist, favorites: s.favorites };
  });

  app.get("/api/user/alerts", async () => {
    const s = await userStore.load();
    return { alerts: s.alerts, triggered: s.triggered.slice(0, 50) };
  });
  app.post("/api/user/alerts", async (req, reply) => {
    const parsed = alertBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid alert", issues: parsed.error.issues });
    const b = parsed.data;
    if ((b.kind === "price_above" || b.kind === "price_below") && (!b.assetId || b.level === undefined)) return reply.code(400).send({ error: "price alerts need assetId and level" });
    if (b.kind === "setup_status" && !b.assetId) return reply.code(400).send({ error: "setup alerts need assetId" });
    const rule: AlertRule = { id: `al_${hashString(`${b.kind}${b.assetId}${b.level}${Date.now()}`)}`, kind: b.kind, assetId: (b.assetId as AssetId | null) ?? null, timeframe: b.timeframe, level: b.level, statuses: b.statuses, note: b.note, active: true, createdAt: Date.now(), lastTriggeredAt: null, triggerCount: 0 };
    await userStore.update((s) => ({ ...s, alerts: [rule, ...s.alerts] }));
    return reply.code(201).send({ alert: rule });
  });
  app.patch("/api/user/alerts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { active?: boolean };
    let found = false;
    await userStore.update((s) => {
      const a = s.alerts.find((x) => x.id === id);
      if (a) {
        found = true;
        if (typeof body.active === "boolean") a.active = body.active;
      }
      return s;
    });
    if (!found) return reply.code(404).send({ error: "alert not found" });
    return { ok: true };
  });
  app.delete("/api/user/alerts/:id", async (req) => {
    const { id } = req.params as { id: string };
    await userStore.update((s) => ({ ...s, alerts: s.alerts.filter((a) => a.id !== id) }));
    return { ok: true };
  });
  app.post("/api/user/alerts/triggered/read", async () => {
    await userStore.update((s) => ({ ...s, triggered: s.triggered.map((t) => ({ ...t, read: true })) }));
    return { ok: true };
  });

  app.get("/api/user/saved-setups", async () => ({ setups: (await userStore.load()).savedSetups }));
  app.post("/api/user/saved-setups", async (req, reply) => {
    const setup = req.body as TradeSetup;
    if (!setup || typeof setup !== "object" || !setup.id || !isAssetId(String(setup.assetId))) return reply.code(400).send({ error: "invalid setup" });
    await userStore.update((s) => ({ ...s, savedSetups: [setup, ...s.savedSetups.filter((x) => x.id !== setup.id)].slice(0, 100) }));
    return reply.code(201).send({ ok: true });
  });
  app.delete("/api/user/saved-setups/:id", async (req) => {
    const { id } = req.params as { id: string };
    await userStore.update((s) => ({ ...s, savedSetups: s.savedSetups.filter((x) => x.id !== id) }));
    return { ok: true };
  });

  app.get("/api/user/saved-analyses", async () => ({ analyses: (await userStore.load()).savedAnalyses }));
  app.post("/api/user/saved-analyses", async (req, reply) => {
    const body = z.object({ title: z.string().min(1).max(120), payload: z.unknown() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid analysis" });
    const entry = { id: `an_${hashString(`${body.data.title}${Date.now()}`)}`, title: body.data.title, createdAt: Date.now(), payload: body.data.payload };
    await userStore.update((s) => ({ ...s, savedAnalyses: [entry, ...s.savedAnalyses].slice(0, 100) }));
    return reply.code(201).send({ analysis: entry });
  });
  app.delete("/api/user/saved-analyses/:id", async (req) => {
    const { id } = req.params as { id: string };
    await userStore.update((s) => ({ ...s, savedAnalyses: s.savedAnalyses.filter((x) => x.id !== id) }));
    return { ok: true };
  });
}

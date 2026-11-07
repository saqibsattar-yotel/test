import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { explainCryptoRegime, explainGoldRegime, explainMtf, explainSetup, TIMEFRAMES, type AssetId, type Timeframe } from "@terminal/core";
import { assets } from "../services/assets";
const isAssetId = (v: string) => assets.isSupported(v.toUpperCase());
import { aiStatus, narrate } from "../services/ai";
import { analyzeAsset, getCryptoRegime, getGoldRegime, getSetup } from "../services/analysis";
import { getSettings } from "../services/user";

export async function aiRoutes(app: FastifyInstance) {
  app.get("/api/ai/status", async () => aiStatus());

  app.post("/api/ai/setup", async (req, reply) => {
    const body = z.object({ assetId: z.string().refine(isAssetId), timeframe: z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]]).default("4h") }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid body" });
    const settings = await getSettings();
    const res = await getSetup(body.data.assetId as AssetId, body.data.timeframe, { accountBalance: settings.accountBalance, riskPct: settings.defaultRiskPct });
    const s = res.primary;
    const facts = {
      setup: { symbol: s.symbol, direction: s.direction, status: s.status, type: s.setupType, timeframe: s.timeframe, contextTimeframe: s.contextTimeframe, currentPrice: s.currentPrice, entry: s.entry, stopLoss: s.stopLoss, targets: s.targets, riskRewardTp1: s.riskRewardTp1, riskRewardTp2: s.riskRewardTp2, qualityScore: s.qualityScore, confidence: s.confidence, regime: s.regime, invalidation: s.invalidation, entryConditions: s.entryConditions, supporting: s.supporting.map((e) => e.text), opposing: s.opposing.map((e) => e.text), rationale: s.rationale, assumptions: s.assumptions, dataQuality: s.dataSource.quality, proxy: !!s.dataSource.proxy, dataAsOf: new Date(s.dataAsOf).toISOString() },
      multiTimeframe: res.mtfSummary,
      alternatives: res.alternatives.slice(0, 2).map((a) => ({ direction: a.direction, type: a.setupType, status: a.status, qualityScore: a.qualityScore })),
    };
    const narrative = await narrate({ kind: "setup", facts, fallback: explainSetup(s), factsAsOf: s.dataAsOf, instruction: "Explain this trade plan to a professional trader: why the setup is interesting, which structure and indicators support it, what must happen before entry, the logic of the stop and each target, and the strongest argument against it. If status is NO TRADE, explain why standing aside is the right call.", effort: "low", maxTokens: 1500 });
    return { narrative, setupId: s.id };
  });

  app.post("/api/ai/mtf", async (req, reply) => {
    const body = z.object({ assetId: z.string().refine(isAssetId) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid body" });
    const a = await analyzeAsset(body.data.assetId as AssetId);
    const facts = { symbol: a.symbol, price: a.price, overallBias: a.mtf.overallBias, alignmentPct: a.mtf.alignmentPct, alignment: a.mtf.alignment, keySupport: a.mtf.keySupport, keyResistance: a.mtf.keyResistance, entryArea: a.mtf.entryArea, confirmations: a.mtf.confirmations, invalidations: a.mtf.invalidations, conflicts: a.mtf.conflicts, perTimeframe: a.mtf.perTimeframe.map((p) => ({ timeframe: p.timeframe, bias: p.bias, strength: p.strength, trend: p.trend, notes: p.notes, rsi: Math.round(p.indicators.rsi14 * 10) / 10, adx: Math.round(p.indicators.adx14), ema20: p.indicators.ema20, ema50: p.indicators.ema50, ema200: p.indicators.ema200, atrPct: Math.round(p.indicators.atrPct * 100) / 100, stale: p.quality.stale })), volatility: a.volatility, warnings: a.warnings };
    const narrative = await narrate({ kind: "mtf", facts, fallback: explainMtf(a.mtf), factsAsOf: a.asOf, instruction: "Give the multi-timeframe read: overall bias, where timeframes agree and disagree (and why that is not a contradiction), key levels, what confirmation to wait for, what invalidates the view, and whether a trade is worth considering.", effort: "low", maxTokens: 1200 });
    return { narrative };
  });

  app.post("/api/ai/regime", async (req, reply) => {
    const body = z.object({ market: z.enum(["crypto", "gold"]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid body" });
    if (body.data.market === "crypto") {
      const r = await getCryptoRegime();
      const narrative = await narrate({ kind: "regime", facts: { score: r.result.score, zone: r.result.zone, guidance: r.result.guidance, components: r.result.components.map((c) => ({ label: c.label, weight: c.weight, score: c.score, available: c.dataAvailable, signal: c.signal })), notes: r.notes }, fallback: explainCryptoRegime(r.result), factsAsOf: r.result.asOf, instruction: "Interpret the crypto market regime score for a trader: which components drive it, what it implies for exposure posture, and what would change the read. Stress that it is descriptive, not predictive.", effort: "low", maxTokens: 1000 });
      return { narrative };
    }
    const r = await getGoldRegime();
    const narrative = await narrate({ kind: "gold", facts: { score: r.result.score, zone: r.result.zone, guidance: r.result.guidance, components: r.result.components.map((c) => ({ label: c.label, weight: c.weight, score: c.score, available: c.dataAvailable, signal: c.signal })), notes: r.notes }, fallback: explainGoldRegime(r.result), factsAsOf: r.result.asOf, instruction: "Interpret gold's macro-technical posture: the trend, the dollar relationship as measured (do not assume an inverse relationship), real yields, momentum and volatility; explain how upcoming macro could shift it. Separate verified data from interpretation.", effort: "low", maxTokens: 1000 });
    return { narrative };
  });
}

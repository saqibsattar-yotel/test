import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ASSETS, CRYPTO_ASSETS, METALS, METAL_ASSETS, TIMEFRAMES, computeIndicatorSnapshot, explainCryptoRegime, explainMetalRegime, explainMtf, explainSetup, type AssetId, type Timeframe, type DataSource } from "@terminal/core";
import { analyzeAsset, getCryptoRegime, getMetalRegime, getSetup, getSetupsFor, DEFAULT_TFS, type MetalRegimeResponse } from "../services/analysis";
import { market, type CandlePayload } from "../services/market";
import { getGoldSilverRatio } from "../services/metals";
import { liquidations } from "../services/liquidations";
import { getCalendar } from "./content";
import { getNews } from "./content";
import { narrate, ruleBasedNarrative } from "../services/ai";
import { isWarming } from "../lib/warming";
import { getSettings } from "../services/user";
import { cache } from "../lib/cache";
import { parseAssets } from "./market";
import { assets } from "../services/assets";
import { hub } from "../ws/hub";

const tfSchema = z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]]);

function parseTfs(raw: unknown): Timeframe[] {
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_TFS;
  const tfs = raw.split(",").map((s) => s.trim()).filter((s): s is Timeframe => (TIMEFRAMES as string[]).includes(s));
  return tfs.length ? tfs : DEFAULT_TFS;
}

export async function analysisRoutes(app: FastifyInstance) {
  app.get("/api/analysis/:assetId", async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    const id = assetId.toUpperCase();
    if (!assets.isSupported(id)) return reply.code(404).send({ error: "unknown asset" });
    hub.ensureSubscribed([id]);
    const q = req.query as { tfs?: string };
    const analysis = await analyzeAsset(id, parseTfs(q.tfs));
    return { ...analysis, mtfExplanation: explainMtf(analysis.mtf) };
  });

  app.get("/api/regime/crypto", async () => {
    const r = await getCryptoRegime();
    return { ...r, explanation: explainCryptoRegime(r.result) };
  });
  for (const id of METAL_ASSETS) {
    const { metal } = METALS[id];
    app.get(`/api/regime/${metal}`, async () => {
      const r = await getMetalRegime(metal);
      return { ...r, explanation: explainMetalRegime(r.result) };
    });
  }

  app.get("/api/setups", async (req, reply) => {
    const q = req.query as { assets?: string; tf?: string; balance?: string; risk?: string };
    const tf = tfSchema.safeParse(q.tf ?? "4h");
    if (!tf.success) return reply.code(400).send({ error: "invalid timeframe" });
    const settings = await getSettings();
    const ids = parseAssets(q.assets, settings.followedAssets);
    hub.ensureSubscribed(ids);
    const balance = parseFloat(q.balance ?? "") || settings.accountBalance;
    const risk = parseFloat(q.risk ?? "") || settings.defaultRiskPct;
    const { setups, errors, warming } = await getSetupsFor(ids, tf.data, { accountBalance: balance, riskPct: risk });
    return { setups, errors, warming, timeframe: tf.data, generatedAt: Date.now() };
  });

  app.get("/api/setups/:assetId", async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    const id = assetId.toUpperCase();
    if (!assets.isSupported(id)) return reply.code(404).send({ error: "unknown asset" });
    hub.ensureSubscribed([id]);
    const q = req.query as { tf?: string; balance?: string; risk?: string };
    const tf = tfSchema.safeParse(q.tf ?? "4h");
    if (!tf.success) return reply.code(400).send({ error: "invalid timeframe" });
    const settings = await getSettings();
    const balance = parseFloat(q.balance ?? "") || settings.accountBalance;
    const risk = parseFloat(q.risk ?? "") || settings.defaultRiskPct;
    const res = await getSetup(id, tf.data, { accountBalance: balance, riskPct: risk });
    return { ...res, explanation: explainSetup(res.primary) };
  });

  // While gold or silver history is still being downloaded for the first time these answer without those parts
  // (`warming: true`); such a partial answer is kept for a few seconds only, not for the full cache period.
  app.get("/api/overview", async () => {
    const res = await cache.getOrLoad("overview", 60_000, buildOverview);
    if (res.value.warming && !res.fromCache) cache.set("overview", res.value, 10_000);
    return res.value;
  });

  app.get("/api/intel", async () => {
    const res = await cache.getOrLoad("intel", 120_000, buildIntel);
    if (res.value.warming && !res.fromCache) cache.set("intel", res.value, 10_000);
    return res.value;
  });
}

async function buildOverview() {
  const settings = await getSettings();
  const now = Date.now();
  const ids: AssetId[] = Array.from(new Set<AssetId>(["BTCUSD", "ETHUSD", "SOLUSD", ...METAL_ASSETS, ...settings.followedAssets]));
  hub.ensureSubscribed(ids);
  const [quotes, global, fng, funding, crypto, gold, goldCandles, silver, silverCandles, btcCandles, events, news] = await Promise.allSettled([
    market.getQuotes(ids),
    market.getGlobal(),
    market.getFearGreed(),
    market.getFunding(CRYPTO_ASSETS),
    getCryptoRegime(),
    getMetalRegime("gold"),
    market.getCandles("XAUUSD", "1d", 300),
    getMetalRegime("silver"),
    market.getCandles("XAGUSD", "1d", 300),
    market.getCandles("BTCUSD", "1d", 300),
    getCalendar(now - 6 * 3_600_000, now + 10 * 86_400_000),
    getNews("all"),
  ]);
  const v = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
  const stillDownloading = (...rs: PromiseSettledResult<unknown>[]) => rs.some((r) => r.status === "rejected" && isWarming(r.reason));
  const warmingMetals = [...(stillDownloading(gold, goldCandles) ? ["gold"] : []), ...(stillDownloading(silver, silverCandles) ? ["silver"] : [])];
  const warming = warmingMetals.length > 0;
  const q = v(quotes) ?? [];
  const g = v(global);
  const f = v(fng);
  const fu = v(funding);
  const cr = v(crypto);
  const gr = v(gold);
  const sr = v(silver);
  const gc = v(goldCandles);
  const sc = v(silverCandles);
  const bc = v(btcCandles);
  const goldInd = gc ? computeIndicatorSnapshot(gc.candles) : null;
  const silverInd = sc ? computeIndicatorSnapshot(sc.candles) : null;
  const btcInd = bc ? computeIndicatorSnapshot(bc.candles) : null;
  const trendOf = (ind: typeof goldInd, candles: CandlePayload | null) => (ind && candles ? { emaStack: ind.emaStack, aboveEma200: ind.close > ind.ema200, rsi: ind.rsi14, atrPct: ind.atrPct, source: candles.source } : null);
  const postureFacts = (r: MetalRegimeResponse | null) => (r ? { score: r.result.score, zone: r.result.zone, drivers: r.result.components.filter((c) => c.dataAvailable).map((c) => `${c.label}: ${c.signal}`) } : null);
  const postureSummary = (r: MetalRegimeResponse | null) => (r ? { score: r.result.score, zone: r.result.zone, guidance: r.result.guidance, notes: r.notes } : null);
  const ev = v(events);
  const nw = v(news);
  const avgFunding = fu && fu.funding.length ? fu.funding.reduce((s, x) => s + x.fundingRate, 0) / fu.funding.length : null;
  const bullish: string[] = [];
  const bearish: string[] = [];
  if (cr) {
    for (const c of cr.result.components.filter((c) => c.dataAvailable)) (c.score >= 60 ? bullish : c.score <= 40 ? bearish : []).push(`Crypto · ${c.label}: ${c.signal}`);
  }
  for (const [name, r] of [["Gold", gr], ["Silver", sr]] as const) {
    if (!r) continue;
    // The yield leg reads the same series and gives the same reading for both metals: listed once, under gold.
    const shared = name === "Silver" && gr ? new Set(["rates"]) : new Set<string>();
    for (const c of r.result.components.filter((c) => c.dataAvailable && !shared.has(c.id))) (c.score >= 60 ? bullish : c.score <= 40 ? bearish : []).push(`${name} · ${c.label}: ${c.signal}`);
  }
  const goldTrend = trendOf(goldInd, gc);
  const silverTrend = trendOf(silverInd, sc);
  const volatility = { btcAtrPct1d: btcInd?.atrPct ?? null, goldAtrPct1d: goldInd?.atrPct ?? null, silverAtrPct1d: silverInd?.atrPct ?? null, btcBollingerSqueeze: btcInd?.bollinger.squeeze ?? null };
  const upcoming = (ev?.events ?? []).filter((e) => e.time >= now - 3_600_000 && (e.importance === "high" || e.official)).slice(0, 8);
  const topNews = (nw?.items ?? []).slice(0, 10);
  const facts = {
    asOf: new Date(now).toISOString(),
    quotes: q.map((x) => ({ asset: x.assetId, price: x.price, changePct24h: x.changePct24h === null ? null : Math.round(x.changePct24h * 100) / 100, quality: x.source.quality, proxy: !!x.source.proxy })),
    cryptoRegime: cr ? { score: cr.result.score, zone: cr.result.zone, drivers: cr.result.components.filter((c) => c.dataAvailable).map((c) => `${c.label}: ${c.signal}`) } : null,
    goldPosture: postureFacts(gr),
    silverPosture: postureFacts(sr),
    fearGreed: f && !("error" in f) ? { value: f.value, label: f.classification } : null,
    totalMarketCapUsd: g && !("error" in g) ? Math.round(g.totalMarketCapUsd) : null,
    btcDominancePct: g && !("error" in g) ? Math.round(g.btcDominancePct * 10) / 10 : null,
    avgFunding8hPct: avgFunding !== null ? Math.round(avgFunding * 1e6) / 1e4 : null,
    upcomingEvents: upcoming.slice(0, 5).map((e) => ({ title: e.title, time: new Date(e.time).toISOString(), importance: e.importance })),
    headlines: topNews.slice(0, 6).map((n) => `${n.publisher}: ${n.title}`),
  };
  const fallback: string[] = [];
  fallback.push(`Market overview as of ${new Date(now).toUTCString()}.`);
  if (cr) fallback.push(`Crypto regime is ${cr.result.zone}${cr.result.score !== null ? ` (${cr.result.score}/100)` : ""} — ${cr.result.guidance}.`);
  if (gr) fallback.push(`Gold posture is ${gr.result.zone}${gr.result.score !== null ? ` (${gr.result.score}/100)` : ""} — ${gr.result.guidance}.`);
  if (sr) fallback.push(`Silver posture is ${sr.result.zone}${sr.result.score !== null ? ` (${sr.result.score}/100)` : ""} — ${sr.result.guidance}.`);
  if (f && !("error" in f)) fallback.push(`Crypto Fear & Greed reads ${f.value} (${f.classification}).`);
  if (avgFunding !== null) fallback.push(`Average perpetual funding across majors is ${(avgFunding * 100).toFixed(4)}% per 8h.`);
  if (upcoming.length) fallback.push(`Next scheduled catalysts: ${upcoming.slice(0, 3).map((e) => `${e.title} (${new Date(e.time).toUTCString()})`).join("; ")}.`);
  // No language-model call for a briefing that is still missing its metals part.
  const briefing = warming
    ? ruleBasedNarrative(fallback, now, `${warmingMetals.length === 2 ? "Gold and silver data are" : `${warmingMetals[0] === "gold" ? "Gold" : "Silver"} data is`} still being downloaded for the first time on this machine; the full briefing follows once ${warmingMetals.length === 2 ? "they are" : "it is"} ready.`)
    : await narrate({ kind: "briefing", facts, fallback, factsAsOf: now, instruction: "Write the daily market briefing for a crypto, gold and silver trader from this fact sheet. Lead with the regime read, then what matters today, then the scheduled risks. Mention data caveats (proxy/demo/stale) first if any.", effort: "medium", maxTokens: 1500, cacheTtlMs: 30 * 60_000 });
  const sources: DataSource[] = [];
  for (const x of q) sources.push(x.source);
  if (g && !("error" in g)) sources.push(g.source);
  if (f && !("error" in f)) sources.push(f.source);
  return {
    generatedAt: now,
    warming,
    quotes: q,
    global: g,
    fearGreed: f,
    funding: fu ? { avg8h: avgFunding, items: fu.funding.map((x) => ({ assetId: x.assetId, rate: x.fundingRate, annualizedPct: x.annualizedPct, nextFundingTime: x.nextFundingTime })), source: fu.source, error: fu.error } : null,
    regime: { crypto: cr ? { score: cr.result.score, zone: cr.result.zone, guidance: cr.result.guidance, notes: cr.notes } : null, gold: postureSummary(gr), silver: postureSummary(sr) },
    goldTrend,
    silverTrend,
    volatility,
    conditions: { bullish, bearish },
    upcomingEvents: upcoming,
    news: topNews,
    briefing,
    assetsMeta: Object.values(ASSETS),
  };
}

async function buildIntel() {
  const now = Date.now();
  const [btc, top, global, funding, oiBtc, oiEth, macro, events, news, cr, gr, sr, ratio] = await Promise.allSettled([
    analyzeAsset("BTCUSD", ["4h", "1d", "1w"]),
    market.getTopCoins(),
    market.getGlobal(),
    market.getFunding(CRYPTO_ASSETS),
    market.getOpenInterest("BTCUSD"),
    market.getOpenInterest("ETHUSD"),
    market.getMacro(),
    getCalendar(now - 12 * 3_600_000, now + 14 * 86_400_000),
    getNews("all"),
    getCryptoRegime(),
    getMetalRegime("gold"),
    getMetalRegime("silver"),
    getGoldSilverRatio(),
  ]);
  const v = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
  const warming = [gr, sr].some((r) => r.status === "rejected" && isWarming(r.reason));
  const t = v(top);
  const coins = t && !("error" in t) ? t.coins : [];
  const alts = coins.filter((c) => c.symbol !== "BTC" && c.change24hPct !== null);
  const altBreadth24h = alts.length ? (alts.filter((c) => (c.change24hPct ?? 0) > 0).length / alts.length) * 100 : null;
  const alts7d = alts.filter((c) => c.change7dPct !== null);
  const altBreadth7d = alts7d.length ? (alts7d.filter((c) => (c.change7dPct ?? 0) > 0).length / alts7d.length) * 100 : null;
  const btcCoin = coins.find((c) => c.symbol === "BTC");
  const outperformers = alts.filter((c) => btcCoin && (c.change24hPct ?? 0) > (btcCoin.change24hPct ?? 0)).length;
  const fu = v(funding);
  const fundingSorted = fu ? [...fu.funding].sort((a, b) => b.fundingRate - a.fundingRate) : [];
  const nw = v(news);
  const items = nw?.items ?? [];
  const ev = v(events);
  const cryptoRegime = v(cr);
  const goldRegime = v(gr);
  const silverRegime = v(sr);
  const b = v(btc);
  const m = v(macro);
  const liq = liquidations.summary(24 * 3_600_000);
  return {
    warming,
    generatedAt: now,
    crypto: {
      btcStructure: b ? { price: b.price, bias: b.mtf.overallBias, alignment: b.mtf.alignment, summary: b.mtf.summary, keySupport: b.mtf.keySupport, keyResistance: b.mtf.keyResistance, perTimeframe: b.mtf.perTimeframe.map((p) => ({ timeframe: p.timeframe, bias: p.bias, trend: p.trend, notes: p.notes.slice(0, 3) })), sources: b.sources } : null,
      altStrength: { breadth24hPct: altBreadth24h, breadth7dPct: altBreadth7d, altsOutperformingBtc24h: alts.length ? `${outperformers}/${alts.length}` : null, leaders: [...alts].sort((a, b2) => (b2.change24hPct ?? 0) - (a.change24hPct ?? 0)).slice(0, 5).map((c) => ({ symbol: c.symbol, change24hPct: c.change24hPct, change7dPct: c.change7dPct })), laggards: [...alts].sort((a, b2) => (a.change24hPct ?? 0) - (b2.change24hPct ?? 0)).slice(0, 5).map((c) => ({ symbol: c.symbol, change24hPct: c.change24hPct, change7dPct: c.change7dPct })), source: t && !("error" in t) ? t.source : null, why: "Breadth tells you whether a BTC move is being confirmed by the rest of the market. Narrow rallies (BTC up, most alts down) are late-cycle or defensive; broad participation confirms risk-on." },
      dominance: v(global),
      funding: { items: fundingSorted, extremes: fundingSorted.filter((f) => Math.abs(f.fundingRate) >= 0.0003), source: fu?.source ?? null, error: fu?.error, why: "Funding is what leveraged longs pay shorts (positive) or vice versa every 8h. Persistently hot funding means crowded longs and liquidation-cascade risk; negative funding marks washed-out positioning that often precedes squeezes higher." },
      openInterest: { btc: v(oiBtc), eth: v(oiEth), why: "Rising open interest with rising price = new money chasing the trend; rising OI with falling price = new shorts or trapped longs; falling OI = positions closing (deleveraging). Combine with funding to judge who is positioned where." },
      liquidations: { ...liq, why: "Forced liquidations are fuel: clusters of long liquidations mark capitulation lows, short liquidations mark squeezes. Large one-sided totals often exhaust a move." },
      regime: cryptoRegime ? { score: cryptoRegime.result.score, zone: cryptoRegime.result.zone, components: cryptoRegime.result.components } : null,
      news: items.filter((n) => n.topics.includes("crypto")).slice(0, 15),
    },
    gold: {
      dollar: m?.dxy ?? null,
      yields: { tenYear: m?.dgs10 ?? null, twoYear: m?.dgs2 ?? null, real10y: m?.real10 ?? null, curve: m?.curve ?? null, errors: m?.errors ?? [] },
      macroReleases: (ev?.events ?? []).filter((e) => e.relatedMarkets.includes("gold") || e.relatedMarkets.includes("silver") || e.relatedMarkets.includes("rates")).slice(0, 12),
      fed: items.filter((n) => n.publisher === "Federal Reserve" || n.relevance.includes("fed")).slice(0, 8),
      geopolitics: items.filter((n) => n.relevance.includes("geopolitics")).slice(0, 8),
      goldNews: items.filter((n) => n.relevance.includes("gold") || n.topics.includes("gold")).slice(0, 12),
      positioning: { available: false, note: "CFTC Commitments of Traders and central-bank purchase data need a dedicated provider (e.g. CFTC public reports parsed weekly, World Gold Council data). Not wired keyless — shown as unavailable rather than estimated." },
      posture: goldRegime ? { score: goldRegime.result.score, zone: goldRegime.result.zone, components: goldRegime.result.components, notes: goldRegime.notes } : null,
      why: { dollar: "Gold is priced in dollars, so dollar strength usually pressures it — but not always: in risk-off episodes both can rise together. The posture component measures the live 60-day correlation instead of assuming the inverse.", yields: "Real yields are gold's opportunity cost. Falling real yields have historically supported gold; sharply rising real yields have been its main headwind.", macro: "CPI, PCE, payrolls and FOMC decisions reset the expected rate path within seconds — the first move after a release is often reversed; wait for the second reaction." },
    },
    silver: {
      posture: silverRegime ? { score: silverRegime.result.score, zone: silverRegime.result.zone, components: silverRegime.result.components, notes: silverRegime.notes } : null,
      ratio: v(ratio),
      silverNews: items.filter((n) => n.relevance.includes("silver")).slice(0, 12),
      positioning: { available: false, note: "CFTC Commitments of Traders, exchange-traded product holdings and Silver Institute supply/demand data need a dedicated provider. Not wired keyless — shown as unavailable rather than estimated." },
      why: {
        drivers: "Silver shares gold's macro drivers (the dollar and real yields) and usually moves in the same direction, with larger swings. It is also an industrial metal: more than half of demand comes from electronics, solar and other manufacturing, so growth and factory data matter for silver in a way they do not for gold.",
        ratio: "The gold/silver ratio is how many ounces of silver one ounce of gold buys. It has often risen in risk-off phases, when gold is bought as a haven while silver trades like an industrial metal, and fallen when silver outperforms in broad metals rallies. It is a relative-value measure, not a timing signal.",
      },
    },
  };
}

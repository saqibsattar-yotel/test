/**
 * Analysis service: wires verified market data into the deterministic core engines.
 * Nothing here invents a number — every figure traces back to a provider payload.
 */
import type { AssetId, Candle, DataSource, Level, Timeframe, TradeSetup } from "@terminal/core";
import {
  CRYPTO_ASSETS,
  analyzeCryptoRegime,
  analyzeGoldRegime,
  analyzeMultiTimeframe,
  computeIndicatorSnapshot,
  dominanceProxyFromCloses,
  findSwings,
  classifyStructure,
  supportResistance,
  periodLevels,
  sessionRanges,
  generateSetups,
  liquidityZones,
  realizedVolatility,
  validateCandles,
  type CryptoRegimeResult,
  type GoldRegimeResult,
  type MtfResult,
  type SetupEngineOutput,
  type IndicatorSnapshot,
  type StructureSummary,
  type SRLevel,
  type PeriodLevels,
  type SessionRange,
  type QualityReport,
} from "@terminal/core";
import { cache } from "../lib/cache";
import { logger } from "../lib/logger";
import { market, CANDLE_LIMITS } from "./market";
import { assets } from "./assets";

const log = logger("analysis");

export const DEFAULT_TFS: Timeframe[] = ["15m", "1h", "4h", "1d"];

export interface AssetCandles {
  byTf: Partial<Record<Timeframe, Candle[]>>;
  sources: Partial<Record<Timeframe, DataSource>>;
  warnings: string[];
}

export async function loadCandles(assetId: AssetId, tfs: Timeframe[]): Promise<AssetCandles> {
  const results = await Promise.all(tfs.map((tf) => market.getCandles(assetId, tf, CANDLE_LIMITS[tf])));
  const byTf: AssetCandles["byTf"] = {};
  const sources: AssetCandles["sources"] = {};
  const warnings: string[] = [];
  results.forEach((r) => {
    byTf[r.timeframe] = r.candles;
    sources[r.timeframe] = r.source;
    warnings.push(...r.warnings);
  });
  return { byTf, sources, warnings };
}

export interface RegimeBundle {
  crypto: CryptoRegimeResult | null;
  cryptoError?: string;
  gold: GoldRegimeResult | null;
  goldError?: string;
  sources: DataSource[];
}

export async function getCryptoRegime(): Promise<{ result: CryptoRegimeResult; sources: DataSource[]; notes: string[] }> {
  const res = await cache.getOrLoad("regime:crypto", 10 * 60_000, async () => {
    const notes: string[] = [];
    const btc = await market.getCandles("BTCUSD", "1d", 500);
    const alts = await market.getAltUniverseDaily();
    notes.push(alts.note);
    const funding = await market.getFunding(CRYPTO_ASSETS);
    if (funding.error) notes.push(`Funding: ${funding.error}`);
    const globalRes = await market.getGlobal();
    const dominanceSeries = await market.getDominanceHistory();
    const btcCloses = btc.candles.map((c) => c.close);
    const proxy = dominanceProxyFromCloses(btcCloses, alts.series, alts.weights);
    if (dominanceSeries.length < 31) notes.push(`Dominance direction uses a BTC/alt-basket relative-strength PROXY until 31 daily observations accumulate (${dominanceSeries.length} so far).`);
    const result = analyzeCryptoRegime({
      btcDailyCloses: btcCloses,
      altDailyCloses: alts.series,
      dominanceSeries,
      dominanceProxySeries: proxy,
      currentDominance: "error" in globalRes ? undefined : globalRes.btcDominancePct,
      funding: Object.fromEntries(funding.funding.map((f) => [f.symbol, f.fundingRate])),
      asOf: Date.now(),
    });
    const sources: DataSource[] = [btc.source];
    if (funding.source) sources.push(funding.source);
    if (!("error" in globalRes)) sources.push(globalRes.source);
    if (btc.source.quality === "demo") notes.push("BTC history is DEMO data — regime is illustrative only.");
    return { result, sources, notes };
  });
  return res.value;
}

export async function getGoldRegime(): Promise<{ result: GoldRegimeResult; sources: DataSource[]; notes: string[] }> {
  const res = await cache.getOrLoad("regime:gold", 10 * 60_000, async () => {
    const notes: string[] = [];
    const gold = await market.getCandles("XAUUSD", "1d", 450);
    const macro = await market.getMacro();
    notes.push(...macro.errors);
    if (gold.source.proxy) notes.push(`Gold history is a labelled proxy (${gold.source.label}) — posture is indicative only.`);
    if (gold.source.quality === "demo") notes.push("Gold history is DEMO data — posture is illustrative only.");
    const result = analyzeGoldRegime({
      goldDaily: gold.candles,
      dxyDaily: macro.dxy?.points.map((p) => p.value),
      tenYearYield: macro.dgs10?.points.map((p) => p.value),
      realYield10y: macro.real10?.points.map((p) => p.value),
      asOf: Date.now(),
      dxyLabel: macro.dxy?.id === "DXY_SYNTH" ? "synthetic DXY" : macro.dxy?.label,
      yieldLabel: "10y",
    });
    const sources: DataSource[] = [gold.source];
    for (const s of [macro.dxy, macro.dgs10, macro.real10]) if (s) sources.push(s.source);
    return { result, sources, notes };
  });
  return res.value;
}

export interface TimeframeDetail {
  timeframe: Timeframe;
  indicators: IndicatorSnapshot | null;
  structure: StructureSummary | null;
  support: SRLevel[];
  resistance: SRLevel[];
  quality: QualityReport;
  source: DataSource;
  bars: number;
}

export interface AssetAnalysis {
  assetId: AssetId;
  symbol: string;
  price: number;
  mtf: MtfResult;
  details: TimeframeDetail[];
  periodLevels: PeriodLevels | null;
  sessions: { today: SessionRange[]; previous: SessionRange[] } | null;
  liquidity: Level[];
  volatility: { atrPct4h: number | null; realizedVol30dPct: number | null; atrPct1d: number | null };
  warnings: string[];
  sources: DataSource[];
  asOf: number;
}

export async function analyzeAsset(assetId: AssetId, tfs: Timeframe[] = DEFAULT_TFS): Promise<AssetAnalysis> {
  const key = `analysis:${assetId}:${tfs.join(",")}`;
  const res = await cache.getOrLoad(key, 45_000, async () => {
    const now = Date.now();
    const meta = assets.meta(assetId);
    const need = Array.from(new Set<Timeframe>([...tfs, "1h", "1d"]));
    const { byTf, sources, warnings } = await loadCandles(assetId, need);
    const mtf = analyzeMultiTimeframe(assetId, Object.fromEntries(tfs.map((tf) => [tf, byTf[tf] ?? []])) as Partial<Record<Timeframe, Candle[]>>, now);
    const details: TimeframeDetail[] = need.map((tf) => {
      const candles = byTf[tf] ?? [];
      const ind = computeIndicatorSnapshot(candles);
      const swings = findSwings(candles, 3, 3);
      const structure = candles.length ? classifyStructure(candles, swings) : null;
      const sr = ind ? supportResistance(candles, swings, ind.atr14, tf) : { support: [], resistance: [] };
      return { timeframe: tf, indicators: ind, structure, support: sr.support, resistance: sr.resistance, quality: validateCandles(candles, tf, now, { minBars: 30, allowGaps: !meta.continuous }), source: sources[tf]!, bars: candles.length };
    });
    const h1 = byTf["1h"] ?? [];
    const h4 = byTf["4h"] ?? [];
    const d1 = byTf["1d"] ?? [];
    const pl = h1.length ? periodLevels(h1, now) : null;
    const sessions = h1.length ? { today: sessionRanges(h1, now, 0), previous: sessionRanges(h1, now, -1) } : null;
    const ind4 = computeIndicatorSnapshot(h4);
    const ind1d = computeIndicatorSnapshot(d1);
    const liq = h4.length && ind4 ? liquidityZones(h4, findSwings(h4, 3, 3), ind4.atr14) : [];
    const rv = d1.length > 35 ? realizedVolatility(d1.map((c) => c.close), 30, 365) * 100 : null;
    return {
      assetId,
      symbol: meta.symbol,
      price: mtf.price,
      mtf,
      details: details.filter((d) => tfs.includes(d.timeframe) || d.timeframe === "1d"),
      periodLevels: pl,
      sessions: meta.assetClass === "gold" ? sessions : null,
      liquidity: liq.slice(0, 6),
      volatility: { atrPct4h: ind4?.atrPct ?? null, realizedVol30dPct: rv !== null && Number.isFinite(rv) ? rv : null, atrPct1d: ind1d?.atrPct ?? null },
      warnings,
      sources: Object.values(sources) as DataSource[],
      asOf: now,
    } satisfies AssetAnalysis;
  });
  return res.value;
}

export interface SetupResponse extends SetupEngineOutput {
  mtfSummary: string[];
  sources: DataSource[];
  warnings: string[];
}

export async function getSetup(assetId: AssetId, timeframe: Timeframe, sizing?: { accountBalance: number; riskPct: number }): Promise<SetupResponse> {
  const key = `setup:${assetId}:${timeframe}:${sizing?.accountBalance ?? 0}:${sizing?.riskPct ?? 0}`;
  const res = await cache.getOrLoad(key, 60_000, async () => {
    const now = Date.now();
    const meta = assets.meta(assetId);
    const tfs: Timeframe[] = Array.from(new Set<Timeframe>(["15m", "1h", "4h", "1d", timeframe]));
    const { byTf, sources, warnings } = await loadCandles(assetId, tfs);
    const mtf = analyzeMultiTimeframe(assetId, byTf, now);
    let regime: { label: string; zone: string; bias: "bullish" | "bearish" | "neutral" | "unknown" } | null = null;
    try {
      if (meta.assetClass === "crypto") {
        const r = (await getCryptoRegime()).result;
        regime = { label: "Crypto regime", zone: r.zone, bias: r.zone === "RISK_ON" ? "bullish" : r.zone === "RISK_OFF" ? "bearish" : r.zone === "UNKNOWN" ? "unknown" : "neutral" };
      } else {
        const r = (await getGoldRegime()).result;
        regime = { label: "Gold posture", zone: r.zone, bias: r.zone === "CONSTRUCTIVE" ? "bullish" : r.zone === "DEFENSIVE" ? "bearish" : r.zone === "UNKNOWN" ? "unknown" : "neutral" };
      }
    } catch (err) {
      log.warn(`regime unavailable for setup: ${(err as Error).message}`);
    }
    const out = generateSetups({ assetId, timeframe, candles: byTf, mtf, regime, now, dataSource: sources[timeframe]!, sizing: sizing ? { ...sizing, prefer: meta.assetClass === "gold" ? "cfd" : "spot" } : undefined });
    return { ...out, mtfSummary: mtf.summary, sources: Object.values(sources) as DataSource[], warnings } satisfies SetupResponse;
  });
  return res.value;
}

export async function getSetupsFor(assets: AssetId[], timeframe: Timeframe, sizing?: { accountBalance: number; riskPct: number }): Promise<{ setups: TradeSetup[]; errors: Record<string, string> }> {
  const errors: Record<string, string> = {};
  const results = await Promise.allSettled(assets.map((a) => getSetup(a, timeframe, sizing)));
  const setups: TradeSetup[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") setups.push(r.value.primary);
    else errors[assets[i]] = (r.reason as Error).message;
  });
  const rank = (s: TradeSetup) => (s.status === "NO TRADE" ? -1 : s.qualityScore);
  setups.sort((a, b) => rank(b) - rank(a));
  return { setups, errors };
}

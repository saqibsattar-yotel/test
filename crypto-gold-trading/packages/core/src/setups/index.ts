/**
 * AI Trade Setup Engine — deterministic part.
 *
 * Every level (entry zone, stop, TP1-3) is derived from market structure, indicators and
 * volatility that were computed from verified candles. The engine scores setup quality
 * from explicit evidence items, applies hard NO-TRADE rules, and is comfortable
 * returning NO TRADE. Narrative explanation (optional LLM) is layered on top in the
 * server and may only reference the numbers produced here.
 */
import type { AssetId, Bias, Candle, DataSource, DataStatusEntry, Direction, EvidenceItem, IndicatorContribution, KeyLevels, Level, MtfConfirmation, SetupStatus, SetupType, Target, Timeframe, TradeSetup } from "../types";
import { isMetalClass, resolveAsset, TIMEFRAME_MS } from "../types";
import { contextTimeframeFor, expectedHoldFor } from "../timeframes";
import { analyzeTimeframe, type MtfResult, type TimeframeAnalysis } from "../mtf";
import { fibonacci, lastImpulse, findSwings, liquidityZones, periodLevels, roundNumberLevels, sessionRanges, type SRLevel } from "../structure";
import { hashString, roundTo } from "../math";
import { defaultSpecFor, sizePosition } from "../risk";

export interface SetupEngineInput {
  assetId: AssetId;
  timeframe: Timeframe;
  candles: Partial<Record<Timeframe, Candle[]>>;
  mtf: MtfResult;
  regime: { label: string; zone: string; bias: "bullish" | "bearish" | "neutral" | "unknown" } | null;
  now: number;
  dataSource: DataSource;
  sizing?: { accountBalance: number; riskPct: number; prefer?: "spot" | "perp" | "cfd" | "futures" };
  /** Reasons the input data must not be traded on (e.g. history with gaps). Any entry forces NO TRADE. */
  dataBlockers?: string[];
}

export interface SetupEngineOutput {
  primary: TradeSetup;
  alternatives: TradeSetup[];
  levels: Level[];
}

interface Candidate {
  direction: Direction;
  type: SetupType;
  entryLow: number;
  entryHigh: number;
  mode: TradeSetup["entry"]["mode"];
  stop: number;
  stopBasis: string;
  conditions: string[];
  evidence: EvidenceItem[];
  rationale: string[];
  invalidation: string;
}

const price2 = (v: number, p: number) => roundTo(v, p);

export function generateSetups(input: SetupEngineInput): SetupEngineOutput {
  const tfCandles = input.candles[input.timeframe];
  const meta = resolveAsset(input.assetId, { price: tfCandles?.[tfCandles.length - 1]?.close });
  const tf = input.timeframe;
  const ctxTf = contextTimeframeFor(tf);
  const now = input.now;
  const exec = input.mtf.perTimeframe.find((a) => a.timeframe === tf) ?? (input.candles[tf] ? analyzeTimeframe(input.candles[tf]!, tf, now, !meta.continuous) : null);
  const ctx = input.mtf.perTimeframe.find((a) => a.timeframe === ctxTf) ?? (input.candles[ctxTf] ? analyzeTimeframe(input.candles[ctxTf]!, ctxTf, now, !meta.continuous) : null);
  const candles = input.candles[tf] ?? [];
  const prec = meta.pricePrecision;

  const noTrade = (reasons: string[], opposing: EvidenceItem[] = []): SetupEngineOutput => {
    const lv = exec ? collectLevels(exec, ctx, candles, meta.roundStep, now, meta.continuous) : [];
    return { primary: buildNoTrade(input, exec, ctx, reasons, opposing, ctxTf, lv), alternatives: [], levels: lv };
  };

  if (!exec || candles.length < 60) return noTrade(["Not enough candles on the trading timeframe to analyse structure (need ≥ 60)."]);
  if (input.dataBlockers?.length) return noTrade(input.dataBlockers, [{ text: "Incomplete market data", weight: -100, category: "data" }]);
  if (!exec.quality.ok) return noTrade([`Data quality errors on ${tf}: ${exec.quality.issues.filter((i) => i.severity === "error").map((i) => i.message).join("; ")}`]);
  if (exec.quality.stale) return noTrade([`Market data on ${tf} is stale (${exec.quality.issues.find((i) => i.code === "stale")?.message}). No setup is generated on stale prices.`], [{ text: "Stale data", weight: -100, category: "data" }]);

  const ind = exec.indicators;
  const price = ind.close;
  const atr = ind.atr14;
  if (!Number.isFinite(atr) || atr <= 0) return noTrade(["ATR could not be computed — volatility unknown."]);
  const levels = collectLevels(exec, ctx, candles, meta.roundStep, now, meta.continuous);
  const swings = findSwings(candles, 3, 3);
  const impulse = lastImpulse(swings);
  const ctxBias = ctx?.bias ?? "neutral";
  const ctxScore = ctx?.score ?? 0;
  const regimeBias = input.regime?.bias ?? "unknown";

  const candidates: Candidate[] = [];
  const ema20 = ind.ema20;
  const ema50 = ind.ema50;
  const supports = exec.support;
  const resistances = exec.resistance;
  const lastSwingLow = exec.structure.lastSwingLow;
  const lastSwingHigh = exec.structure.lastSwingHigh;
  const rv = ind.volume?.relativeVolume ?? 1;
  const liq = levels.filter((l) => l.kind === "liquidity");
  const nearestBelow = (ls: Level[], p: number) => ls.filter((l) => l.price < p).sort((a, b) => b.price - a.price)[0];
  const nearestAbove = (ls: Level[], p: number) => ls.filter((l) => l.price > p).sort((a, b) => a.price - b.price)[0];

  // ---------- LONG: trend pullback ----------
  if (ctxScore >= 2 && (exec.structure.trend === "uptrend" || exec.structure.trend === "transition" || ind.emaStack === "bullish") && Number.isFinite(ema20) && Number.isFinite(ema50)) {
    const zoneHigh = Math.min(ema20, price);
    const zoneLow = Math.min(ema50, zoneHigh - 0.1 * atr);
    const distToZone = price - zoneHigh;
    if (distToZone <= 1.2 * atr && zoneLow > 0) {
      const sup = nearestBelow(supports, zoneLow) as SRLevel | undefined;
      const entryMidL = (zoneLow + zoneHigh) / 2;
      const swingBelow = swings.filter((s) => s.type === "low" && s.price < zoneLow && zoneLow - s.price <= 2.5 * atr).sort((a, b) => b.index - a.index)[0];
      const structuralRef = Math.min(swingBelow ? swingBelow.price : zoneLow, sup && zoneLow - sup.zoneLow <= 2.5 * atr ? sup.zoneLow : zoneLow);
      const { stop, basis: stopBasis } = placeStop("LONG", entryMidL, structuralRef, atr, swingBelow ? `the last higher low (${fmt(swingBelow.price, prec)})` : sup && zoneLow - sup.zoneLow <= 2.5 * atr ? `the support zone (${fmt(sup.zoneLow, prec)})` : "the EMA50 zone", prec);
      const ev: EvidenceItem[] = [
        { text: `${ctxTf} context is bullish (score ${ctxScore})`, weight: 18, category: "trend" },
        { text: exec.structure.trend === "uptrend" ? `${tf} structure: ${exec.structure.description}` : `${tf} EMA stack bullish while structure consolidates`, weight: exec.structure.trend === "uptrend" ? 15 : 8, category: "structure" },
        { text: `Price ${distToZone <= 0 ? "inside" : `${(distToZone / atr).toFixed(1)} ATR above`} the EMA20–EMA50 pullback zone`, weight: distToZone <= 0.3 * atr ? 10 : 5, category: "levels" },
      ];
      if (ind.rsi14 >= 38 && ind.rsi14 <= 60) ev.push({ text: `RSI ${ind.rsi14.toFixed(0)} reset without losing bullish territory`, weight: 8, category: "momentum" });
      else if (ind.rsi14 > 70) ev.push({ text: `RSI ${ind.rsi14.toFixed(0)} overbought — not a pullback yet`, weight: -10, category: "momentum" });
      if (sup) ev.push({ text: `Pullback zone overlaps ${sup.label.toLowerCase()} at ${fmt(sup.price, prec)}`, weight: 8, category: "levels" });
      if (ind.macd.histogram > ind.macd.histogramPrev) ev.push({ text: "MACD histogram turning up", weight: 5, category: "momentum" });
      candidates.push({
        direction: "LONG",
        type: "trend_pullback",
        entryLow: zoneLow,
        entryHigh: zoneHigh,
        mode: distToZone <= 0.3 * atr ? "immediate" : "limit_zone",
        stop,
        stopBasis,
        conditions: distToZone <= 0.3 * atr ? [] : [`Price retraces into ${fmt(zoneLow, prec)}–${fmt(zoneHigh, prec)}`, `${tf} candle closes back above EMA20 (${fmt(ema20, prec)}) from inside the zone`],
        evidence: ev,
        rationale: [`Trend-continuation long: the ${ctxTf} trend is up and the ${tf} is pulling back into the moving-average zone where prior pullbacks found buyers.`],
        invalidation: `A ${tf} close below ${fmt(stop, prec)} breaks the higher-low sequence (${stopBasis}) and invalidates the continuation thesis.`,
      });
    }
  }
  // ---------- SHORT: trend pullback ----------
  if (ctxScore <= -2 && (exec.structure.trend === "downtrend" || exec.structure.trend === "transition" || ind.emaStack === "bearish") && Number.isFinite(ema20) && Number.isFinite(ema50)) {
    const zoneLow = Math.max(ema20, price);
    const zoneHigh = Math.max(ema50, zoneLow + 0.1 * atr);
    const distToZone = zoneLow - price;
    if (distToZone <= 1.2 * atr) {
      const res = nearestAbove(resistances, zoneHigh) as SRLevel | undefined;
      const entryMidS = (zoneLow + zoneHigh) / 2;
      const swingAbove = swings.filter((s) => s.type === "high" && s.price > zoneHigh && s.price - zoneHigh <= 2.5 * atr).sort((a, b) => b.index - a.index)[0];
      const structuralRef = Math.max(swingAbove ? swingAbove.price : zoneHigh, res && res.zoneHigh - zoneHigh <= 2.5 * atr ? res.zoneHigh : zoneHigh);
      const { stop, basis: stopBasis } = placeStop("SHORT", entryMidS, structuralRef, atr, swingAbove ? `the last lower high (${fmt(swingAbove.price, prec)})` : res && res.zoneHigh - zoneHigh <= 2.5 * atr ? `the resistance zone (${fmt(res.zoneHigh, prec)})` : "the EMA50 zone", prec);
      const ev: EvidenceItem[] = [
        { text: `${ctxTf} context is bearish (score ${ctxScore})`, weight: 18, category: "trend" },
        { text: exec.structure.trend === "downtrend" ? `${tf} structure: ${exec.structure.description}` : `${tf} EMA stack bearish while structure consolidates`, weight: exec.structure.trend === "downtrend" ? 15 : 8, category: "structure" },
        { text: `Price ${distToZone <= 0 ? "inside" : `${(distToZone / atr).toFixed(1)} ATR below`} the EMA20–EMA50 retracement zone`, weight: distToZone <= 0.3 * atr ? 10 : 5, category: "levels" },
      ];
      if (ind.rsi14 >= 40 && ind.rsi14 <= 62) ev.push({ text: `RSI ${ind.rsi14.toFixed(0)} relieved without reclaiming bullish territory`, weight: 8, category: "momentum" });
      else if (ind.rsi14 < 30) ev.push({ text: `RSI ${ind.rsi14.toFixed(0)} oversold — not a retracement yet`, weight: -10, category: "momentum" });
      if (res) ev.push({ text: `Retracement zone overlaps ${res.label.toLowerCase()} at ${fmt(res.price, prec)}`, weight: 8, category: "levels" });
      if (ind.macd.histogram < ind.macd.histogramPrev) ev.push({ text: "MACD histogram turning down", weight: 5, category: "momentum" });
      candidates.push({
        direction: "SHORT",
        type: "trend_pullback",
        entryLow: zoneLow,
        entryHigh: zoneHigh,
        mode: distToZone <= 0.3 * atr ? "immediate" : "limit_zone",
        stop,
        stopBasis,
        conditions: distToZone <= 0.3 * atr ? [] : [`Price retraces into ${fmt(zoneLow, prec)}–${fmt(zoneHigh, prec)}`, `${tf} candle closes back below EMA20 (${fmt(ema20, prec)}) from inside the zone`],
        evidence: ev,
        rationale: [`Trend-continuation short: the ${ctxTf} trend is down and the ${tf} is retracing into the moving-average zone where prior rallies were sold.`],
        invalidation: `A ${tf} close above ${fmt(stop, prec)} breaks the lower-high sequence (${stopBasis}) and invalidates the continuation thesis.`,
      });
    }
  }
  // ---------- Breakout / breakdown ----------
  const bo = exec.structure.breakout;
  if (bo && bo.barsAgo <= 3) {
    const level = bo.level;
    if (bo.type === "bullish") {
      const dist = price - level;
      const swingStop = lastSwingLow && lastSwingLow.price < level ? lastSwingLow.price - 0.25 * atr : NaN;
      const levelStop = level - 0.75 * atr;
      const stop = Math.min(Number.isFinite(swingStop) && swingStop > levelStop ? swingStop : levelStop, level - 0.6 * atr);
      const ev: EvidenceItem[] = [
        { text: `${tf} close broke above the prior swing high at ${fmt(level, prec)} ${bo.barsAgo === 0 ? "on the latest bar" : `${bo.barsAgo} bars ago`}`, weight: 16, category: "structure" },
        { text: rv >= 1.3 ? `Breakout volume ${rv.toFixed(1)}x average — participation confirms` : `Breakout volume only ${rv.toFixed(1)}x average — weak confirmation`, weight: rv >= 1.3 ? 10 : -6, category: "volume" },
        { text: ctxScore >= 2 ? `${ctxTf} context bullish — breakout is with the trend` : ctxScore <= -2 ? `${ctxTf} context bearish — breakout is counter-trend` : `${ctxTf} context neutral`, weight: ctxScore >= 2 ? 15 : ctxScore <= -2 ? -12 : 2, category: "trend" },
      ];
      if (ind.bollinger.squeeze) ev.push({ text: "Breakout emerging from a Bollinger squeeze", weight: 6, category: "volatility" });
      if (ind.rsi14 > 75) ev.push({ text: `RSI ${ind.rsi14.toFixed(0)} — stretched; retest entry preferred`, weight: -5, category: "momentum" });
      const immediate = dist <= 0.5 * atr && dist >= 0;
      candidates.push({
        direction: "LONG",
        type: "breakout",
        entryLow: level,
        entryHigh: immediate ? price : level + 0.3 * atr,
        mode: immediate ? "immediate" : "confirmation",
        stop,
        stopBasis: `below the breakout level with a 0.75 ATR buffer${Number.isFinite(swingStop) && swingStop > levelStop ? " (tightened to the last swing low)" : ""}`,
        conditions: immediate ? [] : [`Price retests ${fmt(level, prec)}–${fmt(level + 0.3 * atr, prec)} and holds`, `A ${tf} close back above the retest zone confirms acceptance`],
        evidence: ev,
        rationale: [`Breakout long: price has closed above a resistance that capped the range; the plan is to buy the acceptance/retest rather than chase.`],
        invalidation: `A ${tf} close back below ${fmt(stop, prec)} means the breakout failed (bull trap) and the thesis is invalid.`,
      });
    } else {
      const dist = level - price;
      const swingStop = lastSwingHigh && lastSwingHigh.price > level ? lastSwingHigh.price + 0.25 * atr : NaN;
      const levelStop = level + 0.75 * atr;
      const stop = Math.max(Number.isFinite(swingStop) && swingStop < levelStop ? swingStop : levelStop, level + 0.6 * atr);
      const ev: EvidenceItem[] = [
        { text: `${tf} close broke below the prior swing low at ${fmt(level, prec)} ${bo.barsAgo === 0 ? "on the latest bar" : `${bo.barsAgo} bars ago`}`, weight: 16, category: "structure" },
        { text: rv >= 1.3 ? `Breakdown volume ${rv.toFixed(1)}x average — participation confirms` : `Breakdown volume only ${rv.toFixed(1)}x average — weak confirmation`, weight: rv >= 1.3 ? 10 : -6, category: "volume" },
        { text: ctxScore <= -2 ? `${ctxTf} context bearish — breakdown is with the trend` : ctxScore >= 2 ? `${ctxTf} context bullish — breakdown is counter-trend` : `${ctxTf} context neutral`, weight: ctxScore <= -2 ? 15 : ctxScore >= 2 ? -12 : 2, category: "trend" },
      ];
      if (ind.bollinger.squeeze) ev.push({ text: "Breakdown emerging from a Bollinger squeeze", weight: 6, category: "volatility" });
      if (ind.rsi14 < 25) ev.push({ text: `RSI ${ind.rsi14.toFixed(0)} — stretched; retest entry preferred`, weight: -5, category: "momentum" });
      const immediate = dist <= 0.5 * atr && dist >= 0;
      candidates.push({
        direction: "SHORT",
        type: "breakdown",
        entryLow: immediate ? price : level - 0.3 * atr,
        entryHigh: level,
        mode: immediate ? "immediate" : "confirmation",
        stop,
        stopBasis: `above the breakdown level with a 0.75 ATR buffer${Number.isFinite(swingStop) && swingStop < levelStop ? " (tightened to the last swing high)" : ""}`,
        conditions: immediate ? [] : [`Price retests ${fmt(level - 0.3 * atr, prec)}–${fmt(level, prec)} and is rejected`, `A ${tf} close back below the retest zone confirms acceptance`],
        evidence: ev,
        rationale: [`Breakdown short: price has closed below a support that held the range; the plan is to sell the retest rather than chase.`],
        invalidation: `A ${tf} close back above ${fmt(stop, prec)} means the breakdown failed (bear trap) and the thesis is invalid.`,
      });
    }
  }
  // ---------- Range fade / mean reversion ----------
  const ranging = Math.abs(ctxScore) < 2 || (Number.isFinite(ind.adx14) && ind.adx14 < 18);
  if (ranging) {
    const sup = supports.find((s) => (s.touches ?? 1) >= 2 && price - s.price <= 0.6 * atr && price >= s.zoneLow - 0.2 * atr);
    if (sup && (ind.rsi14 <= 38 || ind.bollinger.percentB <= 0.12)) {
      const stop = sup.zoneLow - 0.75 * atr;
      candidates.push({
        direction: "LONG",
        type: "range_fade",
        entryLow: Math.min(price, sup.price),
        entryHigh: price,
        mode: "immediate",
        stop,
        stopBasis: `below the support zone (${fmt(sup.zoneLow, prec)}) plus 0.75 ATR`,
        conditions: [],
        evidence: [
          { text: `Range context (${ctxTf} score ${ctxScore}${Number.isFinite(ind.adx14) ? `, ADX ${ind.adx14.toFixed(0)}` : ""})`, weight: 12, category: "trend" },
          { text: `Price at ${sup.label.toLowerCase()} ${fmt(sup.price, prec)}`, weight: 14, category: "levels" },
          { text: ind.rsi14 <= 38 ? `RSI ${ind.rsi14.toFixed(0)} near oversold at support` : `Close at/below the lower Bollinger band (%B ${ind.bollinger.percentB.toFixed(2)})`, weight: 10, category: "momentum" },
          { text: ctxScore <= -2 ? `${ctxTf} is bearish — fading support against the trend` : "No higher-timeframe trend opposing the fade", weight: ctxScore <= -2 ? -12 : 4, category: "trend" },
        ],
        rationale: [`Range fade long: in a non-trending context price is testing a support that has held ${sup.touches} times with momentum washed out.`],
        invalidation: `A ${tf} close below ${fmt(stop, prec)} converts the support into a breakdown and invalidates the range thesis.`,
      });
    }
    const res = resistances.find((r) => (r.touches ?? 1) >= 2 && r.price - price <= 0.6 * atr && price <= r.zoneHigh + 0.2 * atr);
    if (res && (ind.rsi14 >= 62 || ind.bollinger.percentB >= 0.88)) {
      const stop = res.zoneHigh + 0.75 * atr;
      candidates.push({
        direction: "SHORT",
        type: "range_fade",
        entryLow: price,
        entryHigh: Math.max(price, res.price),
        mode: "immediate",
        stop,
        stopBasis: `above the resistance zone (${fmt(res.zoneHigh, prec)}) plus 0.75 ATR`,
        conditions: [],
        evidence: [
          { text: `Range context (${ctxTf} score ${ctxScore}${Number.isFinite(ind.adx14) ? `, ADX ${ind.adx14.toFixed(0)}` : ""})`, weight: 12, category: "trend" },
          { text: `Price at ${res.label.toLowerCase()} ${fmt(res.price, prec)}`, weight: 14, category: "levels" },
          { text: ind.rsi14 >= 62 ? `RSI ${ind.rsi14.toFixed(0)} near overbought at resistance` : `Close at/above the upper Bollinger band (%B ${ind.bollinger.percentB.toFixed(2)})`, weight: 10, category: "momentum" },
          { text: ctxScore >= 2 ? `${ctxTf} is bullish — fading resistance against the trend` : "No higher-timeframe trend opposing the fade", weight: ctxScore >= 2 ? -12 : 4, category: "trend" },
        ],
        rationale: [`Range fade short: in a non-trending context price is testing a resistance that has held ${res.touches} times with momentum stretched.`],
        invalidation: `A ${tf} close above ${fmt(stop, prec)} converts the resistance into a breakout and invalidates the range thesis.`,
      });
    }
  }
  // ---------- Liquidity sweep reversal ----------
  const recent = candles.slice(-3);
  for (const lz of liq.slice(0, 4)) {
    if (lz.price < price) {
      const swept = recent.some((c) => c.low < lz.price - 0.05 * atr && c.close > lz.price);
      if (swept && ctxScore > -3) {
        const wickLow = Math.min(...recent.map((c) => c.low));
        candidates.push({
          direction: "LONG",
          type: "liquidity_sweep_reversal",
          entryLow: lz.price,
          entryHigh: Math.max(price, lz.price + 0.2 * atr),
          mode: "confirmation",
          stop: wickLow - 0.3 * atr,
          stopBasis: `below the sweep wick low (${fmt(wickLow, prec)}) plus 0.3 ATR`,
          conditions: [`A ${tf} close holds above ${fmt(lz.price, prec)} after the sweep`, "Follow-through bar closes above the sweep candle's midpoint"],
          evidence: [
            { text: `Price swept ${lz.label.toLowerCase()} at ${fmt(lz.price, prec)} and closed back above it`, weight: 18, category: "structure" },
            { text: ctxScore >= 2 ? `${ctxTf} context bullish — sweep is a trend-continuation entry` : `${ctxTf} context ${ctxBias}`, weight: ctxScore >= 2 ? 12 : 0, category: "trend" },
            { text: rv >= 1.2 ? `Elevated volume on the sweep (${rv.toFixed(1)}x)` : "Sweep volume unremarkable", weight: rv >= 1.2 ? 6 : 0, category: "volume" },
          ],
          rationale: ["Liquidity-sweep reversal long: resting stops below equal lows were taken and price reclaimed the level — a classic failed breakdown."],
          invalidation: `A ${tf} close below ${fmt(wickLow - 0.3 * atr, prec)} means the sweep was a genuine breakdown; thesis invalid.`,
        });
      }
    } else {
      const swept = recent.some((c) => c.high > lz.price + 0.05 * atr && c.close < lz.price);
      if (swept && ctxScore < 3) {
        const wickHigh = Math.max(...recent.map((c) => c.high));
        candidates.push({
          direction: "SHORT",
          type: "liquidity_sweep_reversal",
          entryLow: Math.min(price, lz.price - 0.2 * atr),
          entryHigh: lz.price,
          mode: "confirmation",
          stop: wickHigh + 0.3 * atr,
          stopBasis: `above the sweep wick high (${fmt(wickHigh, prec)}) plus 0.3 ATR`,
          conditions: [`A ${tf} close holds below ${fmt(lz.price, prec)} after the sweep`, "Follow-through bar closes below the sweep candle's midpoint"],
          evidence: [
            { text: `Price swept ${lz.label.toLowerCase()} at ${fmt(lz.price, prec)} and closed back below it`, weight: 18, category: "structure" },
            { text: ctxScore <= -2 ? `${ctxTf} context bearish — sweep is a trend-continuation entry` : `${ctxTf} context ${ctxBias}`, weight: ctxScore <= -2 ? 12 : 0, category: "trend" },
            { text: rv >= 1.2 ? `Elevated volume on the sweep (${rv.toFixed(1)}x)` : "Sweep volume unremarkable", weight: rv >= 1.2 ? 6 : 0, category: "volume" },
          ],
          rationale: ["Liquidity-sweep reversal short: resting stops above equal highs were taken and price fell back below the level — a classic failed breakout."],
          invalidation: `A ${tf} close above ${fmt(wickHigh + 0.3 * atr, prec)} means the sweep was a genuine breakout; thesis invalid.`,
        });
      }
    }
  }

  if (candidates.length === 0) {
    const reasons = [
      `No setup pattern is present on the ${tf} right now: price is ${describeLocation(price, ind, atr)}.`,
      input.mtf.alignment === "conflicting" ? "Timeframes conflict — the engine does not force a trade into disagreement." : `Context (${ctxTf}) is ${ctxBias}; the trading timeframe has not offered a pullback, breakout, range extreme or liquidity sweep.`,
    ];
    return noTrade(reasons, [{ text: "No qualifying pattern", weight: -20, category: "structure" }]);
  }

  // ---------- Score and build ----------
  const built = candidates.map((c) => buildSetup(c, input, exec, ctx, levels, impulse, atr, now)).sort((a, b) => b.qualityScore - a.qualityScore);
  const primary = built[0];
  return { primary, alternatives: built.slice(1), levels };
}

/**
 * Stop placement for trend-pullback setups: beyond the structural reference with a 0.5
 * ATR buffer, never closer than 1 ATR to the entry (noise) and never further than 3 ATR
 * (if structure is that far away, a volatility stop is used and the structural level is
 * reported as the deeper invalidation).
 */
function placeStop(direction: Direction, entryMid: number, structuralRef: number, atr: number, refLabel: string, prec: number): { stop: number; basis: string } {
  if (direction === "LONG") {
    const structural = structuralRef - 0.5 * atr;
    const nearest = entryMid - 1.0 * atr;
    const furthest = entryMid - 3.0 * atr;
    const candidate = Math.min(structural, nearest);
    if (candidate < furthest) return { stop: furthest, basis: `3.0 ATR volatility stop below the entry (structural invalidation below ${refLabel} sits further away at ${fmt(structural, prec)})` };
    if (candidate === nearest && structural > nearest) return { stop: nearest, basis: `1.0 ATR below the entry zone (${refLabel} is inside the noise band, so the volatility floor applies)` };
    return { stop: structural, basis: `below ${refLabel} minus 0.5 ATR` };
  }
  const structural = structuralRef + 0.5 * atr;
  const nearest = entryMid + 1.0 * atr;
  const furthest = entryMid + 3.0 * atr;
  const candidate = Math.max(structural, nearest);
  if (candidate > furthest) return { stop: furthest, basis: `3.0 ATR volatility stop above the entry (structural invalidation above ${refLabel} sits further away at ${fmt(structural, prec)})` };
  if (candidate === nearest && structural < nearest) return { stop: nearest, basis: `1.0 ATR above the entry zone (${refLabel} is inside the noise band, so the volatility floor applies)` };
  return { stop: structural, basis: `above ${refLabel} plus 0.5 ATR` };
}

function describeLocation(price: number, ind: TimeframeAnalysis["indicators"], atr: number): string {
  const parts: string[] = [];
  if (Number.isFinite(ind.ema20)) parts.push(`${((price - ind.ema20) / atr).toFixed(1)} ATR ${price >= ind.ema20 ? "above" : "below"} EMA20`);
  if (Number.isFinite(ind.rsi14)) parts.push(`RSI ${ind.rsi14.toFixed(0)}`);
  if (Number.isFinite(ind.adx14)) parts.push(`ADX ${ind.adx14.toFixed(0)}`);
  return parts.join(", ") || "mid-range";
}

function collectLevels(exec: TimeframeAnalysis, ctx: TimeframeAnalysis | null, candles: Candle[], roundStep: number, now: number, continuous: boolean): Level[] {
  const out: Level[] = [];
  const price = exec.indicators.close;
  for (const s of exec.support) out.push({ ...s, label: `${exec.timeframe} ${s.label}` });
  for (const r of exec.resistance) out.push({ ...r, label: `${exec.timeframe} ${r.label}` });
  if (ctx) {
    for (const s of ctx.support) out.push({ ...s, label: `${ctx.timeframe} ${s.label}`, strength: Math.min(1, s.strength + 0.15) });
    for (const r of ctx.resistance) out.push({ ...r, label: `${ctx.timeframe} ${r.label}`, strength: Math.min(1, r.strength + 0.15) });
  }
  const ind = exec.indicators;
  for (const [k, v] of [["EMA 20", ind.ema20], ["EMA 50", ind.ema50], ["EMA 100", ind.ema100], ["EMA 200", ind.ema200]] as [string, number][]) {
    if (Number.isFinite(v)) out.push({ price: v, kind: "ema", label: `${exec.timeframe} ${k}`, strength: k === "EMA 200" ? 0.6 : 0.4, timeframe: exec.timeframe });
  }
  if (Number.isFinite(ind.vwap)) out.push({ price: ind.vwap, kind: "vwap", label: "VWAP (UTC day)", strength: 0.35, timeframe: exec.timeframe });
  if (Number.isFinite(ind.bollinger.upper)) {
    out.push({ price: ind.bollinger.upper, kind: "bollinger", label: "Bollinger upper", strength: 0.3 });
    out.push({ price: ind.bollinger.lower, kind: "bollinger", label: "Bollinger lower", strength: 0.3 });
  }
  const swings = findSwings(candles, 3, 3);
  const imp = lastImpulse(swings);
  if (imp) {
    const fib = fibonacci(imp.low.price, imp.high.price, imp.direction);
    for (const r of fib.retracements) out.push({ price: r.price, kind: "fib_retracement", label: `Fib ${r.ratio} retracement`, strength: r.ratio === 0.618 || r.ratio === 0.5 ? 0.45 : 0.3 });
    for (const e of fib.extensions) out.push({ price: e.price, kind: "fib_extension", label: `Fib ${e.ratio} extension`, strength: e.ratio === 1.618 ? 0.45 : 0.35 });
  }
  out.push(...roundNumberLevels(price, roundStep, 3));
  out.push(...liquidityZones(candles, swings, ind.atr14));
  if (TIMEFRAME_MS[exec.timeframe] <= TIMEFRAME_MS["1h"]) {
    const pl = periodLevels(candles, now);
    if (pl.prevDayHigh) out.push({ price: pl.prevDayHigh, kind: "prev_day_high", label: "Previous day high", strength: 0.5 });
    if (pl.prevDayLow) out.push({ price: pl.prevDayLow, kind: "prev_day_low", label: "Previous day low", strength: 0.5 });
    if (pl.prevWeekHigh) out.push({ price: pl.prevWeekHigh, kind: "prev_week_high", label: "Previous week high", strength: 0.55 });
    if (pl.prevWeekLow) out.push({ price: pl.prevWeekLow, kind: "prev_week_low", label: "Previous week low", strength: 0.55 });
    if (!continuous) {
      for (const s of sessionRanges(candles, now)) {
        if (s.high !== null && s.low !== null) {
          out.push({ price: s.high, kind: "session_high", label: `${s.name} session high`, strength: 0.4 });
          out.push({ price: s.low, kind: "session_low", label: `${s.name} session low`, strength: 0.4 });
        }
      }
    }
  }
  return out.filter((l) => Number.isFinite(l.price) && l.price > 0);
}

function pickTargets(direction: Direction, entry: number, stop: number, levels: Level[], impulse: ReturnType<typeof lastImpulse>, atr: number, prec: number): Target[] {
  const risk = Math.abs(entry - stop);
  const candidates = levels
    .filter((l) => (direction === "LONG" ? l.price > entry + 0.5 * risk : l.price < entry - 0.5 * risk))
    .filter((l) => l.kind !== "ema" && l.kind !== "vwap" && l.kind !== "bollinger" && l.kind !== "fib_retracement")
    .map((l) => ({ ...l, r: Math.abs(l.price - entry) / risk }))
    .sort((a, b) => a.r - b.r);
  const targets: Target[] = [];
  const used = new Set<number>();
  const take = (minR: number, label: Target["label"], fallbackR: number, fallbackBasis: string) => {
    const pick = candidates.find((c) => c.r >= minR && !used.has(c.price) && c.strength >= 0.3);
    if (pick) {
      used.add(pick.price);
      targets.push({ label, price: price2(pick.price, prec), basis: pick.label, rMultiple: roundTo(pick.r, 2) });
    } else {
      const p = direction === "LONG" ? entry + fallbackR * risk : entry - fallbackR * risk;
      targets.push({ label, price: price2(p, prec), basis: fallbackBasis, rMultiple: fallbackR });
    }
  };
  take(1.0, "TP1", 1.5, "No structural level between 1R and 1.5R — ATR/R-multiple projection (1.5R)");
  const r1 = targets[0].rMultiple;
  take(Math.max(r1 + 0.7, 2.0), "TP2", Math.max(r1 + 1, 2.5), "R-multiple projection (no structural level available)");
  const r2 = targets[1].rMultiple;
  // TP3: prefer fib extension of the impulse if it sits beyond TP2
  let tp3: Target | null = null;
  if (impulse) {
    const fib = fibonacci(impulse.low.price, impulse.high.price, direction === "LONG" ? "up" : "down");
    const ext = fib.extensions.find((e) => (direction === "LONG" ? e.price > entry + r2 * risk * 1.15 : e.price < entry - r2 * risk * 1.15));
    if (ext) tp3 = { label: "TP3", price: price2(ext.price, prec), basis: `Fib ${ext.ratio} extension of the last impulse`, rMultiple: roundTo(Math.abs(ext.price - entry) / risk, 2) };
  }
  if (!tp3) {
    const pick = candidates.find((c) => c.r >= r2 + 1 && !used.has(c.price));
    tp3 = pick ? { label: "TP3", price: price2(pick.price, prec), basis: pick.label, rMultiple: roundTo(pick.r, 2) } : { label: "TP3", price: price2(direction === "LONG" ? entry + (r2 + 1.5) * risk : entry - (r2 + 1.5) * risk, prec), basis: "R-multiple projection (trend-extension target)", rMultiple: roundTo(r2 + 1.5, 2) };
  }
  targets.push(tp3);
  return targets;
}

function buildSetup(c: Candidate, input: SetupEngineInput, exec: TimeframeAnalysis, ctx: TimeframeAnalysis | null, levels: Level[], impulse: ReturnType<typeof lastImpulse>, atr: number, now: number): TradeSetup {
  const meta = resolveAsset(input.assetId, { price: exec.indicators.close });
  const prec = meta.pricePrecision;
  const tf = input.timeframe;
  const price = exec.indicators.close;
  const entryMid = (c.entryLow + c.entryHigh) / 2;
  const stop = price2(c.stop, prec);
  const targets = pickTargets(c.direction, entryMid, stop, levels, impulse, atr, prec);
  const risk = Math.abs(entryMid - stop);
  const rr1 = targets[0].rMultiple;
  const rr2 = targets[1].rMultiple;
  const evidence = [...c.evidence];
  const opposing: EvidenceItem[] = [];

  // Risk/reward
  evidence.push({ text: `Reward:risk ${rr1.toFixed(1)}R to TP1 and ${rr2.toFixed(1)}R to TP2`, weight: rr2 >= 2.5 ? 10 : rr2 >= 2 ? 8 : rr2 >= 1.5 ? 4 : -8, category: "risk" });
  // Stop sanity
  const stopAtr = risk / atr;
  if (stopAtr < 0.6) evidence.push({ text: `Stop is only ${stopAtr.toFixed(2)} ATR away — inside normal noise`, weight: -12, category: "volatility" });
  else if (stopAtr > 3) evidence.push({ text: `Stop is ${stopAtr.toFixed(1)} ATR away — wide; size will be small`, weight: -6, category: "volatility" });
  else evidence.push({ text: `Stop distance ${stopAtr.toFixed(1)} ATR — outside noise, inside structure`, weight: 6, category: "volatility" });
  // MTF alignment
  const aligned = input.mtf.overallBias === (c.direction === "LONG" ? "bullish" : "bearish");
  const against = input.mtf.overallBias === (c.direction === "LONG" ? "bearish" : "bullish");
  if (c.type !== "range_fade") {
    if (aligned && input.mtf.alignment === "aligned") evidence.push({ text: `Multi-timeframe alignment ${input.mtf.alignmentPct}% in favour`, weight: 10, category: "trend" });
    else if (aligned) evidence.push({ text: `Multi-timeframe bias agrees (${input.mtf.alignmentPct}% weight)`, weight: 5, category: "trend" });
    else if (against) evidence.push({ text: `Multi-timeframe bias is ${input.mtf.overallBias} — this setup is counter-trend`, weight: -15, category: "trend" });
    else evidence.push({ text: "Multi-timeframe bias is neutral", weight: -3, category: "trend" });
  }
  // Regime
  if (input.regime) {
    const rb = input.regime.bias;
    if (rb !== "unknown") {
      const agrees = (rb === "bullish" && c.direction === "LONG") || (rb === "bearish" && c.direction === "SHORT");
      const disagrees = (rb === "bearish" && c.direction === "LONG") || (rb === "bullish" && c.direction === "SHORT");
      evidence.push({ text: `${input.regime.label}: ${input.regime.zone}${agrees ? " — supportive" : disagrees ? " — opposing" : " — neutral"}`, weight: agrees ? 5 : disagrees ? -8 : 0, category: "regime" });
    }
  }
  // Data quality warnings
  const warnings = exec.quality.issues.filter((i) => i.severity === "warning" && i.code !== "stale");
  if (warnings.length) evidence.push({ text: `Data warnings on ${tf}: ${warnings.map((w) => w.code).join(", ")}`, weight: -5, category: "data" });
  if (exec.indicators.volume && exec.indicators.volume.relativeVolume < 0.5 && c.type !== "range_fade") evidence.push({ text: "Volume well below average — low conviction", weight: -5, category: "volume" });

  const supporting = evidence.filter((e) => e.weight > 0);
  for (const e of evidence) if (e.weight < 0) opposing.push(e);
  const raw = evidence.reduce((s, e) => s + e.weight, 0);
  // Scale: positive evidence can reach ~90+; normalise to 0-100 with a soft cap.
  let score = Math.max(0, Math.min(100, Math.round(35 + raw * 0.75)));

  // Evidence sufficiency: an actionable plan needs several independent supporting items
  // that clearly outweigh the opposing ones and include trend or structure evidence.
  const supportingWeight = supporting.reduce((s, e) => s + e.weight, 0);
  const opposingWeight = opposing.reduce((s, e) => s + Math.abs(e.weight), 0);
  const categoriesCovered = [...new Set(supporting.map((e) => e.category))];
  const insufficiency: string[] = [];
  if (supporting.length < 3) insufficiency.push(`Only ${supporting.length} supporting evidence item(s); at least 3 are required`);
  if (supportingWeight < 40) insufficiency.push(`Supporting weight ${supportingWeight} is below the 40-point threshold`);
  if (!categoriesCovered.includes("trend") && !categoriesCovered.includes("structure")) insufficiency.push("No trend or structure evidence supports the direction");
  if (supportingWeight <= opposingWeight * 1.5) insufficiency.push(`Opposing weight (${opposingWeight}) is too close to supporting weight (${supportingWeight})`);
  const sufficiency = { sufficient: insufficiency.length === 0, supportingWeight, opposingWeight, supportingCount: supporting.length, categoriesCovered, reasons: insufficiency };

  // Multi-timeframe confirmation: the context timeframe must agree and no more lower/higher
  // timeframes may oppose than agree (range fades only require the context not to oppose).
  const dirBias: Bias = c.direction === "LONG" ? "bullish" : "bearish";
  const mtfConfirmation: MtfConfirmation[] = input.mtf.perTimeframe.map((p) => ({ timeframe: p.timeframe, bias: p.bias, strength: p.strength, agrees: p.bias === "neutral" ? null : p.bias === dirBias, note: p.notes[0] ?? "" }));
  const ctxConf = mtfConfirmation.find((m) => m.timeframe === contextTimeframeFor(tf));
  const othersConf = mtfConfirmation.filter((m) => m.timeframe !== tf);
  const agreeing = othersConf.filter((m) => m.agrees === true).length;
  const opposingTfs = othersConf.filter((m) => m.agrees === false).length;
  const mtfConfirmed = c.type === "range_fade" ? (ctxConf ? ctxConf.agrees !== false : true) : ctxConf ? ctxConf.agrees === true && agreeing >= opposingTfs : aligned;

  const hardNoTrade: string[] = [];
  if (rr1 < 1.0) hardNoTrade.push(`Reward to TP1 is below 1R (${rr1.toFixed(2)}R)`);
  if (rr2 < 1.5) hardNoTrade.push(`Reward to TP2 is below 1.5R (${rr2.toFixed(2)}R)`);
  if (stopAtr < 0.5) hardNoTrade.push("Stop inside volatility noise (< 0.5 ATR)");
  if (against && input.mtf.alignment === "aligned" && c.type !== "range_fade") hardNoTrade.push("Setup is counter to a fully aligned multi-timeframe trend");
  if (supportingWeight < 25) hardNoTrade.push(`Insufficient supporting evidence (${supportingWeight} points)`);

  let status: SetupStatus;
  if (hardNoTrade.length) {
    status = "NO TRADE";
    score = Math.min(score, 35);
  } else if (score >= 75) status = c.direction === "LONG" ? "STRONG LONG" : "STRONG SHORT";
  else if (score >= 60) status = c.conditions.length ? "WAIT FOR CONFIRMATION" : c.direction === "LONG" ? "LONG" : "SHORT";
  else if (score >= 45) status = "WAIT FOR CONFIRMATION";
  else status = "NEUTRAL";
  if (status === "STRONG LONG" || status === "STRONG SHORT") {
    if (c.conditions.length) status = c.direction === "LONG" ? "LONG" : "SHORT";
  }
  const actionable = status === "STRONG LONG" || status === "STRONG SHORT" || status === "LONG" || status === "SHORT";
  const gateNotes: string[] = [];
  if (actionable && !sufficiency.sufficient) {
    status = "WAIT FOR CONFIRMATION";
    gateNotes.push(`Held at WAIT: evidence not yet sufficient — ${insufficiency.join("; ")}.`);
  }
  if (actionable && !mtfConfirmed) {
    status = "WAIT FOR CONFIRMATION";
    gateNotes.push(`Held at WAIT: multi-timeframe confirmation missing (${ctxConf ? `${ctxConf.timeframe} is ${ctxConf.bias}` : "no context timeframe"}; ${agreeing} agreeing vs ${opposingTfs} opposing timeframes).`);
  }
  const confidence: TradeSetup["confidence"] = score >= 75 && input.mtf.alignment !== "conflicting" ? "high" : score >= 55 ? "medium" : "low";
  const barMs = TIMEFRAME_MS[tf];
  const expiresAt = now + barMs * (c.mode === "confirmation" ? 10 : 6);
  const entryBasis = entryBasisFor(c, tf, prec);
  const rationale = [...c.rationale, `Entry ${c.mode === "immediate" ? "is actionable near the current price" : c.mode === "limit_zone" ? "is a limit zone — wait for price to come to it" : "requires confirmation — do not pre-empt"}: ${fmt(c.entryLow, prec)}–${fmt(c.entryHigh, prec)} — ${entryBasis}.`, `Stop ${fmt(stop, prec)} sits ${c.stopBasis}.`, ...targets.map((t) => `${t.label} ${fmt(t.price, prec)} (${t.rMultiple.toFixed(1)}R): ${t.basis}.`), ...gateNotes];
  if (hardNoTrade.length) rationale.unshift(`NO TRADE: ${hardNoTrade.join("; ")}.`);

  let sizingPreview: TradeSetup["sizingPreview"];
  if (input.sizing && status !== "NO TRADE") {
    const spec = defaultSpecFor(input.assetId, input.sizing.prefer ?? (isMetalClass(meta.assetClass) ? "cfd" : "spot"));
    const s = sizePosition({ accountBalance: input.sizing.accountBalance, accountCurrency: "USD", riskPct: input.sizing.riskPct, direction: c.direction, entry: entryMid, stop, takeProfit: targets[1].price, spec });
    if (s.status === "SIZED") sizingPreview = { accountBalance: input.sizing.accountBalance, riskPct: input.sizing.riskPct, quantity: s.quantity, quantityUnit: s.quantityUnit, riskAmount: s.potentialLossAccount, potentialProfitTp2: s.potentialProfitAccount ?? 0 };
  }

  const id = `st_${input.assetId}_${tf}_${hashString(`${c.direction}${c.type}${price2(entryMid, prec)}${stop}${exec.lastBarTime}`)}`;
  return {
    id,
    assetId: input.assetId,
    symbol: meta.symbol,
    direction: c.direction,
    status,
    setupType: c.type,
    timeframe: tf,
    contextTimeframe: contextTimeframeFor(tf),
    currentPrice: price2(price, prec),
    entry: { low: price2(c.entryLow, prec), high: price2(c.entryHigh, prec), mid: price2(entryMid, prec), mode: c.mode },
    stopLoss: stop,
    targets,
    riskRewardTp1: roundTo(rr1, 2),
    riskRewardTp2: roundTo(rr2, 2),
    qualityScore: score,
    confidence,
    expectedHold: expectedHoldFor(tf),
    regime: input.regime ? `${input.regime.label}: ${input.regime.zone}` : "Regime unavailable",
    invalidation: c.invalidation,
    expiresAt,
    entryConditions: c.conditions,
    supporting,
    opposing,
    rationale,
    dataAsOf: exec.lastBarTime + barMs,
    dataSource: input.dataSource,
    assumptions: [
      `Levels computed from ${exec.bars} ${tf} candles ending ${new Date(exec.lastBarTime).toISOString()}${ctx ? ` and ${ctx.bars} ${ctx.timeframe} candles` : ""}.`,
      "ATR(14) on the trading timeframe defines volatility buffers (0.25–0.75 ATR).",
      "Quality score is a methodology-based assessment, not a win probability.",
      "No slippage, fees or funding are modelled in the R multiples.",
    ],
    contributions: buildContributions(exec, ctx, c.direction),
    mtfConfirmation,
    mtfConfirmed,
    keyLevels: buildKeyLevels(levels, price, exec),
    sufficiency,
    dataStatus: buildDataStatus(input),
    entryBasis,
    stopBasis: c.stopBasis,
    sizingPreview,
    generatedAt: now,
  };
}

function entryBasisFor(c: Candidate, tf: Timeframe, prec: number): string {
  const zone = `${fmt(c.entryLow, prec)}–${fmt(c.entryHigh, prec)}`;
  switch (c.type) {
    case "trend_pullback":
      return `${tf} EMA20–EMA50 pullback zone (${zone}); continuation entries where prior pullbacks found ${c.direction === "LONG" ? "buyers" : "sellers"}`;
    case "breakout":
      return `retest zone just above the broken resistance (${zone}); acceptance above the level confirms the breakout`;
    case "breakdown":
      return `retest zone just below the broken support (${zone}); rejection below the level confirms the breakdown`;
    case "range_fade":
      return `range extreme at tested ${c.direction === "LONG" ? "support" : "resistance"} (${zone}) with exhausted momentum`;
    case "liquidity_sweep_reversal":
      return `reclaim of the swept liquidity level (${zone}) after stops were taken`;
    default:
      return `entry zone ${zone}`;
  }
}

function buildContributions(exec: TimeframeAnalysis, ctx: TimeframeAnalysis | null, direction: Direction | null): IndicatorContribution[] {
  const out: IndicatorContribution[] = [];
  const dirBias: Bias | null = direction ? (direction === "LONG" ? "bullish" : "bearish") : null;
  const add = (a: TimeframeAnalysis, indicator: string, value: string, read: Bias, weight: number, note?: string) => {
    const signed = dirBias === null || read === "neutral" ? (read === "neutral" ? 0 : weight) : read === dirBias ? weight : -weight;
    out.push({ indicator, timeframe: a.timeframe, value, read, weight: signed, note });
  };
  const analyses = ctx ? [exec, ctx] : [exec];
  for (const a of analyses) {
    const i = a.indicators;
    add(a, "EMA stack (20/50/200)", i.emaStack, i.emaStack === "bullish" ? "bullish" : i.emaStack === "bearish" ? "bearish" : "neutral", 3, `EMA20 ${fmt(i.ema20, 2)} · EMA50 ${fmt(i.ema50, 2)}${Number.isFinite(i.ema200) ? ` · EMA200 ${fmt(i.ema200, 2)}` : ""}`);
    if (Number.isFinite(i.ema200)) add(a, "Price vs EMA200", i.close > i.ema200 ? "above" : "below", i.close > i.ema200 ? "bullish" : "bearish", 2, `EMA200 ${fmt(i.ema200, 2)}`);
    add(a, "Market structure", a.structure.trend, a.structure.trend === "uptrend" ? "bullish" : a.structure.trend === "downtrend" ? "bearish" : "neutral", 3, a.structure.description);
    if (Number.isFinite(i.rsi14)) add(a, "RSI (14)", i.rsi14.toFixed(1), i.rsi14 > 55 ? "bullish" : i.rsi14 < 45 ? "bearish" : "neutral", 2, i.rsi14 >= 70 ? "overbought" : i.rsi14 <= 30 ? "oversold" : undefined);
    if (Number.isFinite(i.macd.histogram)) add(a, "MACD histogram", `${i.macd.histogram >= 0 ? "+" : ""}${fmt(i.macd.histogram, 2)}`, i.macd.histogram > 0 ? "bullish" : i.macd.histogram < 0 ? "bearish" : "neutral", 2, Math.abs(i.macd.histogram) > Math.abs(i.macd.histogramPrev) ? "expanding" : "contracting");
    if (Number.isFinite(i.adx14)) add(a, "ADX / DI (14)", `${i.adx14.toFixed(0)} · +DI ${i.plusDI.toFixed(0)} / −DI ${i.minusDI.toFixed(0)}`, i.adx14 >= 18 ? (i.plusDI > i.minusDI ? "bullish" : "bearish") : "neutral", 1, i.adx14 >= 25 ? "trending" : i.adx14 >= 18 ? "developing trend" : "ranging");
    if (a === exec) {
      if (Number.isFinite(i.vwap)) add(a, "Price vs VWAP", i.close > i.vwap ? "above" : "below", i.close > i.vwap ? "bullish" : "bearish", 1, `VWAP ${fmt(i.vwap, 2)}`);
      if (Number.isFinite(i.bollinger.percentB)) add(a, "Bollinger %B", i.bollinger.percentB.toFixed(2), "neutral", 0, i.bollinger.squeeze ? "squeeze" : i.bollinger.percentB > 1 ? "above upper band" : i.bollinger.percentB < 0 ? "below lower band" : "inside bands");
      if (i.volume) add(a, "Relative volume", `${i.volume.relativeVolume.toFixed(2)}x`, "neutral", 0, `${i.volume.trend} trend · OBV ${i.volume.obvDirection}${i.volume.spike ? " · spike" : ""}`);
    }
  }
  return out;
}

function buildKeyLevels(levels: Level[], price: number, exec: TimeframeAnalysis): KeyLevels {
  const entry = (l: Level) => ({ price: l.price, label: l.label, strength: l.strength, kind: l.kind });
  const srKinds = new Set(["support", "resistance", "prev_day_high", "prev_day_low", "prev_week_high", "prev_week_low", "session_high", "session_low"]);
  const sr = levels.filter((l) => srKinds.has(l.kind));
  const liq = levels.filter((l) => l.kind === "liquidity");
  return {
    support: sr.filter((l) => l.price < price).sort((a, b) => b.price - a.price).slice(0, 5).map(entry),
    resistance: sr.filter((l) => l.price > price).sort((a, b) => a.price - b.price).slice(0, 5).map(entry),
    liquidityAbove: liq.filter((l) => l.price > price).sort((a, b) => a.price - b.price).slice(0, 3).map(entry),
    liquidityBelow: liq.filter((l) => l.price < price).sort((a, b) => b.price - a.price).slice(0, 3).map(entry),
    structure: { trend: exec.structure.trend, description: exec.structure.description, lastSwingHigh: exec.structure.lastSwingHigh?.price ?? null, lastSwingLow: exec.structure.lastSwingLow?.price ?? null, breakout: exec.structure.breakout ? `${exec.structure.breakout.type} break of ${exec.structure.breakout.level} (${exec.structure.breakout.barsAgo} bars ago)` : null },
  };
}

function buildDataStatus(input: SetupEngineInput): DataStatusEntry[] {
  return input.mtf.perTimeframe.map((p) => ({ timeframe: p.timeframe, asOf: p.lastBarTime + TIMEFRAME_MS[p.timeframe], bars: p.bars, stale: p.quality.stale, ok: p.quality.ok, issues: p.quality.issues.map((i) => i.message) }));
}

function buildNoTrade(input: SetupEngineInput, exec: TimeframeAnalysis | null, ctx: TimeframeAnalysis | null, reasons: string[], opposing: EvidenceItem[], ctxTf: Timeframe, levels: Level[]): TradeSetup {
  const meta = resolveAsset(input.assetId, { price: exec?.indicators.close });
  const price = exec ? exec.indicators.close : NaN;
  return {
    id: `st_${input.assetId}_${input.timeframe}_notrade_${hashString(reasons.join("|") + (exec?.lastBarTime ?? 0))}`,
    assetId: input.assetId,
    symbol: meta.symbol,
    direction: null,
    status: "NO TRADE",
    setupType: null,
    timeframe: input.timeframe,
    contextTimeframe: ctxTf,
    currentPrice: Number.isFinite(price) ? roundTo(price, meta.pricePrecision) : 0,
    entry: { low: 0, high: 0, mid: 0, mode: "confirmation" },
    stopLoss: null,
    targets: [],
    riskRewardTp1: null,
    riskRewardTp2: null,
    qualityScore: 0,
    confidence: "low",
    expectedHold: "—",
    regime: input.regime ? `${input.regime.label}: ${input.regime.zone}` : "Regime unavailable",
    invalidation: "No active thesis.",
    expiresAt: input.now + TIMEFRAME_MS[input.timeframe],
    entryConditions: [],
    supporting: [],
    opposing,
    rationale: reasons,
    dataAsOf: exec ? exec.lastBarTime + TIMEFRAME_MS[input.timeframe] : input.now,
    dataSource: input.dataSource,
    assumptions: ["The engine declines to force a trade when conditions are unclear."],
    contributions: exec ? buildContributions(exec, ctx, null) : [],
    mtfConfirmation: input.mtf.perTimeframe.map((p) => ({ timeframe: p.timeframe, bias: p.bias, strength: p.strength, agrees: null, note: p.notes[0] ?? "" })),
    mtfConfirmed: false,
    keyLevels: exec ? buildKeyLevels(levels, price, exec) : null,
    sufficiency: { sufficient: false, supportingWeight: 0, opposingWeight: opposing.reduce((s, e) => s + Math.abs(e.weight), 0), supportingCount: 0, categoriesCovered: [], reasons },
    dataStatus: buildDataStatus(input),
    generatedAt: input.now,
  };
}

function fmt(v: number, prec: number): string {
  if (!Number.isFinite(v)) return "n/a";
  return v.toLocaleString("en-US", { minimumFractionDigits: Math.min(prec, 2), maximumFractionDigits: prec });
}

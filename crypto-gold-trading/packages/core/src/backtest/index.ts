/**
 * Walk-forward backtester for the setup engine.
 *
 * Bias controls:
 *  - No look-ahead: a signal on bar i uses candles[0..i] only (closed bars), context
 *    timeframes are resampled from the same window, and fills can happen from bar i+1.
 *  - Conservative intra-bar resolution: if a bar touches both the stop and a target, the
 *    stop is assumed to hit first; targets never fill on the entry bar.
 *  - Costs: fees per side on notional plus slippage on market-style fills (immediate entries,
 *    stop exits). Limit fills and target exits pay fees but no slippage.
 *  - Survivorship: the test runs on the asset you choose today; it cannot see delisted
 *    coins, so multi-asset conclusions carry survivorship bias (documented in the result).
 */
import type { AssetId, Candle, Direction, SetupStatus, Timeframe, TradeSetup } from "../types";
import { TIMEFRAME_MS } from "../types";
import { contextTimeframeFor, resample } from "../timeframes";
import { analyzeMultiTimeframe } from "../mtf";
import { generateSetups } from "../setups";

export interface BacktestConfig {
  assetId: AssetId;
  timeframe: Timeframe;
  feesBps: number; // per side, on notional
  slippageBps: number; // on market-style fills
  riskPct: number; // of current equity per trade
  startingEquity: number;
  exitModel: "tp1" | "tp2" | "tp3" | "ladder";
  maxPendingBars: number;
  minQuality: number;
  splitPct: number; // in-sample share of the period
  stepBars: number; // evaluate a new signal every N bars
  allowLongs: boolean;
  allowShorts: boolean;
  warmupBars: number;
}

export const DEFAULT_BACKTEST_CONFIG: Omit<BacktestConfig, "assetId" | "timeframe"> = {
  feesBps: 5,
  slippageBps: 3,
  riskPct: 1,
  startingEquity: 10_000,
  exitModel: "ladder",
  maxPendingBars: 6,
  minQuality: 60,
  splitPct: 0.7,
  stepBars: 1,
  allowLongs: true,
  allowShorts: true,
  warmupBars: 260,
};

export interface BacktestTrade {
  id: number;
  direction: Direction;
  setupType: string;
  status: SetupStatus;
  quality: number;
  signalBar: number;
  signalTime: number;
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  stop: number;
  targets: number[];
  exitBar: number;
  exitTime: number;
  exitPrice: number; // average exit for ladder
  exitReason: "stop" | "tp1" | "tp2" | "tp3" | "breakeven" | "end";
  rMultiple: number;
  pnl: number;
  fees: number;
  quantity: number;
  barsHeld: number;
  sample: "in" | "out";
}

export interface BacktestStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  expectancyR: number;
  profitFactor: number;
  totalPnl: number;
  returnPct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  avgR: number;
  bestR: number;
  worstR: number;
  avgBarsHeld: number;
  equityCurve: { time: number; equity: number; drawdown: number }[];
  rDistribution: { bucket: string; count: number }[];
  bySetup: { key: string; trades: number; winRate: number; avgR: number; totalPnl: number }[];
  byDirection: { key: string; trades: number; winRate: number; avgR: number; totalPnl: number }[];
}

export interface BacktestResult {
  config: BacktestConfig;
  bars: number;
  periodFrom: number;
  periodTo: number;
  inSampleUntil: number;
  signals: number;
  all: BacktestStats;
  inSample: BacktestStats;
  outOfSample: BacktestStats;
  trades: BacktestTrade[];
  warnings: string[];
  assumptions: string[];
  durationMs: number;
}

interface Pending {
  setup: TradeSetup;
  signalBar: number;
  expiresBar: number;
}
interface Position {
  trade: Omit<BacktestTrade, "exitBar" | "exitTime" | "exitPrice" | "exitReason" | "rMultiple" | "pnl" | "fees" | "barsHeld" | "sample">;
  remaining: number; // fraction still open (ladder)
  realizedPnl: number;
  realizedR: number;
  fees: number;
  stop: number; // may move to breakeven in ladder mode
  hitTp: number; // targets hit so far
  exitPricesWeighted: number;
}

const ACTIONABLE: SetupStatus[] = ["STRONG LONG", "LONG", "SHORT", "STRONG SHORT"];

export function runBacktest(candles: Candle[], cfgIn: Partial<BacktestConfig> & { assetId: AssetId; timeframe: Timeframe }): BacktestResult {
  const t0 = Date.now();
  const cfg: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, ...cfgIn };
  const n = candles.length;
  const warnings: string[] = [];
  const tf = cfg.timeframe;
  const barMs = TIMEFRAME_MS[tf];
  const ctxTf = contextTimeframeFor(tf);
  const higher: Timeframe[] = (["1h", "4h", "1d", "1w"] as Timeframe[]).filter((h) => TIMEFRAME_MS[h] > barMs);
  const trades: BacktestTrade[] = [];
  let equity = cfg.startingEquity;
  let pending: Pending | null = null;
  let position: Position | null = null;
  let signals = 0;
  let tradeId = 0;
  const splitBar = Math.floor(n * cfg.splitPct);
  const fee = (notional: number) => (notional * cfg.feesBps) / 10_000;
  const slip = (price: number, dir: Direction, adverseForEntry: boolean) => price * (1 + ((dir === "LONG") === adverseForEntry ? 1 : -1) * (cfg.slippageBps / 10_000));
  const dataSource = { provider: "backtest", label: "Historical candles (backtest)", fetchedAt: t0, asOf: t0, quality: "live" as const };

  if (n < cfg.warmupBars + 20) warnings.push(`Only ${n} bars; need at least ${cfg.warmupBars + 20} for a meaningful test.`);

  const closeTrade = (pos: Position, bar: number, exitPrice: number, reason: BacktestTrade["exitReason"], fraction: number) => {
    const t = pos.trade;
    const dir = t.direction === "LONG" ? 1 : -1;
    const qty = t.quantity * fraction;
    const gross = (exitPrice - t.entryPrice) * dir * qty;
    const f = fee(exitPrice * qty);
    pos.realizedPnl += gross - f;
    pos.fees += f;
    const rUnit = Math.abs(t.entryPrice - t.stop);
    pos.realizedR += (((exitPrice - t.entryPrice) * dir) / rUnit) * fraction;
    pos.exitPricesWeighted += exitPrice * fraction;
    pos.remaining = Math.max(0, pos.remaining - fraction);
    if (pos.remaining <= 1e-9) {
      equity += pos.realizedPnl;
      trades.push({ ...t, exitBar: bar, exitTime: candles[bar].time, exitPrice: pos.exitPricesWeighted, exitReason: reason, rMultiple: Math.round(pos.realizedR * 100) / 100, pnl: Math.round(pos.realizedPnl * 100) / 100, fees: Math.round(pos.fees * 100) / 100, barsHeld: bar - t.entryBar, sample: t.signalBar < splitBar ? "in" : "out" });
      position = null;
    }
  };

  for (let i = cfg.warmupBars; i < n; i++) {
    const bar = candles[i];
    // 1) manage open position on this bar
    if (position) {
      const pos: Position = position;
      const t = pos.trade;
      const long = t.direction === "LONG";
      const stopHit = long ? bar.low <= pos.stop : bar.high >= pos.stop;
      if (stopHit && i > t.entryBar) {
        const reason: BacktestTrade["exitReason"] = pos.stop === t.entryPrice ? "breakeven" : "stop";
        closeTrade(pos, i, slip(pos.stop, t.direction, false), reason, pos.remaining);
      } else if (i > t.entryBar) {
        const targets = t.targets;
        if (cfg.exitModel === "ladder") {
          while (position && pos.hitTp < 3) {
            const tp = targets[pos.hitTp];
            const hit = long ? bar.high >= tp : bar.low <= tp;
            if (!hit) break;
            const fraction = pos.hitTp === 2 ? pos.remaining : 1 / 3;
            closeTrade(pos, i, tp, `tp${pos.hitTp + 1}` as BacktestTrade["exitReason"], fraction);
            pos.hitTp++;
            if (pos.hitTp === 1) pos.stop = t.entryPrice; // breakeven after TP1
          }
        } else {
          const idx = cfg.exitModel === "tp1" ? 0 : cfg.exitModel === "tp2" ? 1 : 2;
          const tp = targets[idx];
          if (long ? bar.high >= tp : bar.low <= tp) closeTrade(pos, i, tp, `tp${idx + 1}` as BacktestTrade["exitReason"], pos.remaining);
        }
      }
      if (position && i === n - 1) closeTrade(position, i, bar.close, "end", (position as Position).remaining);
      if (position) continue; // still open: no new signals while in a trade
    }
    // 2) pending order: try to fill on this bar
    if (pending) {
      const s = pending.setup;
      const long = s.direction === "LONG";
      if (i > pending.expiresBar) {
        pending = null;
      } else {
        let fillPrice: number | null = null;
        if (s.entry.mode === "immediate") fillPrice = slip(bar.open, s.direction!, true);
        else {
          const limit = s.entry.mid;
          const touched = long ? bar.low <= limit : bar.high >= limit;
          if (touched) fillPrice = long ? Math.min(limit, bar.open) : Math.max(limit, bar.open);
        }
        if (fillPrice !== null) {
          const stop = s.stopLoss as number;
          const rUnit = Math.abs(fillPrice - stop);
          if (rUnit > 0) {
            const riskBudget = equity * (cfg.riskPct / 100);
            const quantity = riskBudget / rUnit;
            const entryFee = fee(fillPrice * quantity);
            position = { trade: { id: ++tradeId, direction: s.direction!, setupType: s.setupType ?? "other", status: s.status, quality: s.qualityScore, signalBar: pending.signalBar, signalTime: candles[pending.signalBar].time, entryBar: i, entryTime: bar.time, entryPrice: fillPrice, stop, targets: s.targets.map((t) => t.price), quantity }, remaining: 1, realizedPnl: -entryFee, realizedR: 0, fees: entryFee, stop, hitTp: 0, exitPricesWeighted: 0 };
            pending = null;
            // Conservative: a stop touched on the fill bar counts.
            const stopHit = long ? bar.low <= stop : bar.high >= stop;
            if (stopHit) closeTrade(position, i, slip(stop, s.direction!, false), "stop", 1);
            else if (i === n - 1) closeTrade(position, i, bar.close, "end", 1);
            continue;
          }
          pending = null;
        }
      }
    }
    // 3) flat: look for a new signal on the close of bar i
    if (!position && !pending && (i - cfg.warmupBars) % cfg.stepBars === 0 && i < n - 1) {
      const window = candles.slice(0, i + 1);
      const now = bar.time + barMs;
      const byTf: Partial<Record<Timeframe, Candle[]>> = { [tf]: window };
      for (const h of higher) byTf[h] = resample(window, tf, h);
      const mtf = analyzeMultiTimeframe(cfg.assetId, byTf, now);
      const out = generateSetups({ assetId: cfg.assetId, timeframe: tf, candles: byTf, mtf, regime: null, now, dataSource });
      const s = out.primary;
      if (ACTIONABLE.includes(s.status) && s.qualityScore >= cfg.minQuality && s.direction && s.stopLoss !== null && ((s.direction === "LONG" && cfg.allowLongs) || (s.direction === "SHORT" && cfg.allowShorts))) {
        signals++;
        pending = { setup: s, signalBar: i, expiresBar: i + cfg.maxPendingBars };
      }
    }
  }

  const all = computeBacktestStats(trades, cfg.startingEquity);
  const inSample = computeBacktestStats(trades.filter((t) => t.sample === "in"), cfg.startingEquity);
  const outOfSample = computeBacktestStats(trades.filter((t) => t.sample === "out"), cfg.startingEquity);
  if (all.trades < 20) warnings.push(`Only ${all.trades} completed trades — statistics are not reliable (aim for 50+).`);
  if (inSample.trades >= 10 && outOfSample.trades >= 5 && outOfSample.expectancyR < inSample.expectancyR * 0.5) warnings.push("Out-of-sample expectancy is well below in-sample — treat in-sample results as optimistic.");
  if (outOfSample.trades < 5) warnings.push("Fewer than 5 out-of-sample trades — the split cannot validate the in-sample result.");
  return {
    config: cfg,
    bars: n,
    periodFrom: candles[0]?.time ?? 0,
    periodTo: candles[n - 1]?.time ?? 0,
    inSampleUntil: candles[Math.min(n - 1, splitBar)]?.time ?? 0,
    signals,
    all,
    inSample,
    outOfSample,
    trades,
    warnings,
    assumptions: [
      `Signals use closed bars only; a signal on bar i can fill from bar i+1. Context timeframe (${ctxTf}) is resampled from the same series (lower timeframes are not available in the test).`,
      `Fees ${cfg.feesBps} bps per side on notional; slippage ${cfg.slippageBps} bps on market-style fills (immediate entries, stop exits). Limit fills and target exits carry no slippage.`,
      "If a bar touches both the stop and a target, the stop is assumed to hit first. Targets never fill on the entry bar.",
      cfg.exitModel === "ladder" ? "Ladder exit: one third at TP1 (stop moved to breakeven), one third at TP2, the rest at TP3." : `Full exit at ${cfg.exitModel.toUpperCase()}.`,
      `Position size risks ${cfg.riskPct}% of current equity per trade (compounding). One position at a time; pending signals expire after ${cfg.maxPendingBars} bars.`,
      `In-sample = first ${Math.round(cfg.splitPct * 100)}% of the period by time; out-of-sample = the rest. Trades are assigned by signal time.`,
      "Survivorship: the test can only see assets that exist today; results across many coins would overstate performance.",
    ],
    durationMs: Date.now() - t0,
  };
}

export function computeBacktestStats(trades: BacktestTrade[], startingEquity: number): BacktestStats {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const wins = sorted.filter((t) => t.pnl > 0);
  const losses = sorted.filter((t) => t.pnl < 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = -losses.reduce((s, t) => s + t.pnl, 0);
  const rs = sorted.map((t) => t.rMultiple);
  let equity = startingEquity;
  let peak = equity;
  let maxDD = 0;
  let maxDDPct = 0;
  const equityCurve: BacktestStats["equityCurve"] = sorted.length ? [{ time: sorted[0].entryTime, equity, drawdown: 0 }] : [];
  for (const t of sorted) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    if (dd > maxDD) {
      maxDD = dd;
      maxDDPct = peak > 0 ? (dd / peak) * 100 : 0;
    }
    equityCurve.push({ time: t.exitTime, equity, drawdown: dd });
  }
  const buckets = ["≤ -1R", "-1R…0", "0…1R", "1R…2R", "2R…3R", "≥ 3R"];
  const rDistribution = buckets.map((bucket) => ({ bucket, count: 0 }));
  for (const r of rs) {
    const idx = r <= -1 ? 0 : r < 0 ? 1 : r < 1 ? 2 : r < 2 ? 3 : r < 3 ? 4 : 5;
    rDistribution[idx].count++;
  }
  const group = (key: (t: BacktestTrade) => string) => {
    const m = new Map<string, BacktestTrade[]>();
    for (const t of sorted) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
    return [...m.entries()].map(([k, ts]) => ({ key: k, trades: ts.length, winRate: (ts.filter((t) => t.pnl > 0).length / ts.length) * 100, avgR: ts.reduce((s, t) => s + t.rMultiple, 0) / ts.length, totalPnl: ts.reduce((s, t) => s + t.pnl, 0) }));
  };
  const winRate = sorted.length ? (wins.length / sorted.length) * 100 : 0;
  const avgWin = wins.length ? gp / wins.length : 0;
  const avgLoss = losses.length ? gl / losses.length : 0;
  return {
    trades: sorted.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWin,
    avgLoss,
    expectancy: sorted.length ? (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss : 0,
    expectancyR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    totalPnl: gp - gl,
    returnPct: ((gp - gl) / startingEquity) * 100,
    maxDrawdown: maxDD,
    maxDrawdownPct: maxDDPct,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0,
    bestR: rs.length ? Math.max(...rs) : 0,
    worstR: rs.length ? Math.min(...rs) : 0,
    avgBarsHeld: sorted.length ? sorted.reduce((s, t) => s + t.barsHeld, 0) / sorted.length : 0,
    equityCurve,
    rDistribution,
    bySetup: group((t) => t.setupType),
    byDirection: group((t) => t.direction),
  };
}

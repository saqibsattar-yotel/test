/**
 * Trade journal types and performance statistics. All metrics are computed only from
 * recorded trades; test data is flagged and can be excluded.
 */
import type { AssetClass, AssetId, Direction, SetupType, Timeframe } from "../types";
import { rMultiple } from "../risk";
import { zonedParts } from "../time";

export interface JournalTrade {
  id: string;
  assetId: AssetId;
  assetClass: AssetClass;
  symbol: string;
  direction: Direction;
  setupType: SetupType | "other";
  timeframe: Timeframe;
  entry: number;
  stop: number;
  takeProfit: number | null;
  quantity: number;
  quantityUnit: string;
  riskPct: number;
  riskAmount: number; // account currency
  entryReasoning: string;
  screenshots: string[]; // data URLs or file names
  exitPrice: number | null;
  exitAt: number | null;
  realizedPnl: number | null; // account currency
  rMultiple: number | null;
  mae: number | null; // max adverse excursion in R (optional, user supplied)
  mfe: number | null;
  mistakes: string;
  lessons: string;
  status: "open" | "closed";
  openedAt: number;
  closedAt: number | null;
  tags: string[];
  source: "manual" | "setup" | "paper";
  isTestData: boolean;
  setupId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CloseTradeInput {
  exitPrice: number;
  exitAt: number;
  realizedPnl?: number | null; // if omitted it is derived from quantity * contractSize * move
  contractSize?: number;
  fxQuoteToAccount?: number;
  mistakes?: string;
  lessons?: string;
  mae?: number | null;
  mfe?: number | null;
}

export function closeTrade(trade: JournalTrade, input: CloseTradeInput): JournalTrade {
  const move = trade.direction === "LONG" ? input.exitPrice - trade.entry : trade.entry - input.exitPrice;
  const derived = trade.quantity * (input.contractSize ?? 1) * move * (input.fxQuoteToAccount ?? 1);
  const pnl = input.realizedPnl !== undefined && input.realizedPnl !== null && Number.isFinite(input.realizedPnl) ? input.realizedPnl : derived;
  return {
    ...trade,
    exitPrice: input.exitPrice,
    exitAt: input.exitAt,
    closedAt: input.exitAt,
    realizedPnl: pnl,
    rMultiple: rMultiple(trade.direction, trade.entry, trade.stop, input.exitPrice),
    mistakes: input.mistakes ?? trade.mistakes,
    lessons: input.lessons ?? trade.lessons,
    mae: input.mae ?? trade.mae,
    mfe: input.mfe ?? trade.mfe,
    status: "closed",
    updatedAt: input.exitAt,
  };
}

export interface EquityPoint {
  time: number;
  equity: number; // cumulative P&L (plus starting balance if provided)
  drawdown: number; // from running peak, absolute
}

export interface SetupStats {
  key: string;
  trades: number;
  winRate: number;
  avgR: number;
  totalPnl: number;
  profitFactor: number;
}

export interface PerformanceStats {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number; // percent
  avgWin: number;
  avgLoss: number; // positive number
  avgR: number;
  avgWinR: number;
  avgLossR: number;
  achievedRR: number; // avgWin / avgLoss
  profitFactor: number;
  expectancy: number; // currency per trade
  expectancyR: number;
  totalPnl: number;
  grossProfit: number;
  grossLoss: number;
  maxDrawdown: number;
  maxDrawdownPct: number | null;
  largestWin: number;
  largestLoss: number;
  equityCurve: EquityPoint[];
  monthly: { month: string; pnl: number; trades: number; winRate: number }[];
  bySetup: SetupStats[];
  byAsset: SetupStats[];
  byClass: Record<AssetClass, SetupStats | null>;
  bestSetups: SetupStats[];
  worstSetups: SetupStats[];
  includesTestData: boolean;
}

function groupStats(key: string, trades: JournalTrade[]): SetupStats {
  const closed = trades.filter((t) => t.status === "closed" && t.realizedPnl !== null);
  const wins = closed.filter((t) => (t.realizedPnl ?? 0) > 0);
  const losses = closed.filter((t) => (t.realizedPnl ?? 0) < 0);
  const gp = wins.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
  const gl = -losses.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
  const rs = closed.map((t) => t.rMultiple).filter((r): r is number => r !== null && Number.isFinite(r));
  return {
    key,
    trades: closed.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0,
    totalPnl: gp - gl,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
  };
}

export function computePerformance(trades: JournalTrade[], opts: { includeTestData?: boolean; startingBalance?: number | null; zone?: string } = {}): PerformanceStats {
  const zone = opts.zone ?? "UTC";
  const all = trades.filter((t) => opts.includeTestData || !t.isTestData);
  const closed = all.filter((t) => t.status === "closed" && t.realizedPnl !== null && Number.isFinite(t.realizedPnl)).sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  const wins = closed.filter((t) => (t.realizedPnl as number) > 0);
  const losses = closed.filter((t) => (t.realizedPnl as number) < 0);
  const breakeven = closed.length - wins.length - losses.length;
  const grossProfit = wins.reduce((s, t) => s + (t.realizedPnl as number), 0);
  const grossLoss = -losses.reduce((s, t) => s + (t.realizedPnl as number), 0);
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const rs = closed.map((t) => t.rMultiple).filter((r): r is number => r !== null && Number.isFinite(r));
  const winRs = wins.map((t) => t.rMultiple).filter((r): r is number => r !== null && Number.isFinite(r));
  const lossRs = losses.map((t) => t.rMultiple).filter((r): r is number => r !== null && Number.isFinite(r));
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
  const lossRate = closed.length ? (losses.length / closed.length) * 100 : 0;
  // Equity curve & drawdown
  let equity = opts.startingBalance ?? 0;
  let peak = equity;
  let maxDD = 0;
  let maxDDPct: number | null = null;
  const equityCurve: EquityPoint[] = [];
  if (closed.length) equityCurve.push({ time: closed[0].openedAt, equity, drawdown: 0 });
  for (const t of closed) {
    equity += t.realizedPnl as number;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) {
      maxDD = dd;
      maxDDPct = peak > 0 ? (dd / peak) * 100 : null;
    }
    equityCurve.push({ time: t.closedAt ?? t.openedAt, equity, drawdown: dd });
  }
  // Monthly
  const monthMap = new Map<string, JournalTrade[]>();
  for (const t of closed) {
    const p = zonedParts(t.closedAt ?? t.openedAt, zone);
    const key = `${p.year}-${String(p.month).padStart(2, "0")}`;
    monthMap.set(key, [...(monthMap.get(key) ?? []), t]);
  }
  const monthly = [...monthMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, ts]) => ({ month, pnl: ts.reduce((s, t) => s + (t.realizedPnl as number), 0), trades: ts.length, winRate: (ts.filter((t) => (t.realizedPnl as number) > 0).length / ts.length) * 100 }));
  const by = (fn: (t: JournalTrade) => string) => {
    const m = new Map<string, JournalTrade[]>();
    for (const t of closed) m.set(fn(t), [...(m.get(fn(t)) ?? []), t]);
    return [...m.entries()].map(([k, ts]) => groupStats(k, ts)).sort((a, b) => b.totalPnl - a.totalPnl);
  };
  const bySetup = by((t) => t.setupType);
  const byAsset = by((t) => t.symbol);
  const crypto = closed.filter((t) => t.assetClass === "crypto");
  const gold = closed.filter((t) => t.assetClass === "gold");
  const qualified = bySetup.filter((s) => s.trades >= 3);
  return {
    totalTrades: all.length,
    openTrades: all.filter((t) => t.status === "open").length,
    closedTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    breakeven,
    winRate,
    avgWin,
    avgLoss,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0,
    avgWinR: winRs.length ? winRs.reduce((a, b) => a + b, 0) / winRs.length : 0,
    avgLossR: lossRs.length ? lossRs.reduce((a, b) => a + b, 0) / lossRs.length : 0,
    achievedRR: avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy: closed.length ? (winRate / 100) * avgWin - (lossRate / 100) * avgLoss : 0,
    expectancyR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0,
    totalPnl: grossProfit - grossLoss,
    grossProfit,
    grossLoss,
    maxDrawdown: maxDD,
    maxDrawdownPct: maxDDPct,
    largestWin: wins.length ? Math.max(...wins.map((t) => t.realizedPnl as number)) : 0,
    largestLoss: losses.length ? Math.min(...losses.map((t) => t.realizedPnl as number)) : 0,
    equityCurve,
    monthly,
    bySetup,
    byAsset,
    byClass: { crypto: crypto.length ? groupStats("crypto", crypto) : null, gold: gold.length ? groupStats("gold", gold) : null },
    bestSetups: qualified.slice(0, 3),
    worstSetups: [...qualified].sort((a, b) => a.totalPnl - b.totalPnl).slice(0, 3),
    includesTestData: !!opts.includeTestData && all.some((t) => t.isTestData),
  };
}

export type OutcomeCategory = "TRUE_POSITIVE" | "FALSE_POSITIVE_MILD" | "FALSE_POSITIVE_SEVERE" | "NEUTRAL" | "REGIME_MISMATCH";

/**
 * Postmortem outcome classification (from signal-postmortem): compares the predicted
 * direction with the realised move; a regime change during the hold reclassifies
 * severe losses as REGIME_MISMATCH rather than skill error.
 */
export function classifyOutcome(direction: Direction, entry: number, exit: number, regimeAtEntry?: string | null, regimeAtExit?: string | null): OutcomeCategory {
  const ret = ((direction === "LONG" ? exit - entry : entry - exit) / entry) * 100;
  if (regimeAtEntry && regimeAtExit && regimeAtEntry !== regimeAtExit && ret < -2) return "REGIME_MISMATCH";
  if (Math.abs(ret) < 0.5) return "NEUTRAL";
  if (ret > 0) return "TRUE_POSITIVE";
  return ret <= -2 ? "FALSE_POSITIVE_SEVERE" : "FALSE_POSITIVE_MILD";
}

export interface JournalFilter {
  assetId?: AssetId | "all";
  assetClass?: AssetClass | "all";
  timeframe?: Timeframe | "all";
  setupType?: string | "all";
  status?: "open" | "closed" | "all";
  from?: number | null;
  to?: number | null;
  includeTestData?: boolean;
}

export function filterTrades(trades: JournalTrade[], f: JournalFilter): JournalTrade[] {
  return trades.filter((t) => {
    if (f.assetId && f.assetId !== "all" && t.assetId !== f.assetId) return false;
    if (f.assetClass && f.assetClass !== "all" && t.assetClass !== f.assetClass) return false;
    if (f.timeframe && f.timeframe !== "all" && t.timeframe !== f.timeframe) return false;
    if (f.setupType && f.setupType !== "all" && t.setupType !== f.setupType) return false;
    if (f.status && f.status !== "all" && t.status !== f.status) return false;
    if (f.from && t.openedAt < f.from) return false;
    if (f.to && t.openedAt > f.to) return false;
    if (!f.includeTestData && t.isTestData) return false;
    return true;
  });
}

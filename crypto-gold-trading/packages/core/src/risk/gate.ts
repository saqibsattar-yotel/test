/**
 * Pre-Trade Discipline Gate and Drawdown Circuit Breaker. Adapted from the
 * tradermonty/claude-trading-skills `pre-trade-discipline-gate` and
 * `drawdown-circuit-breaker` methodologies (MIT). Both are advisory checklists for a
 * human — this software never places orders.
 */
import { zonedParts, zonedTimeToUtc } from "../time";

export interface ClosedTradeLite {
  closedAt: number; // epoch ms
  realizedPnl: number; // account currency
}

export type CircuitState = "TRADING_ALLOWED" | "COOLDOWN" | "HALTED";

export interface CircuitBreakerConfig {
  maxDailyLossPct: number;
  losingStreakN: number;
  cooldownHours: number;
  weeklyDrawdownPct: number;
  monthlyDrawdownPct: number;
  zone: string; // accounting timezone (UTC for 24/7 crypto by default)
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  maxDailyLossPct: 2.0,
  losingStreakN: 2,
  cooldownHours: 24,
  weeklyDrawdownPct: 5.0,
  monthlyDrawdownPct: 8.0,
  zone: "UTC",
};

export interface TriggeredRule {
  rule: string;
  state: CircuitState;
  detail: string;
  activeUntil: number | null;
}

export interface CircuitBreakerDecision {
  recommendation: CircuitState;
  triggered: TriggeredRule[];
  metrics: { dailyPnl: number; weeklyPnl: number; monthlyPnl: number; consecutiveLosses: number; tradesScanned: number };
  asOf: number;
  config: CircuitBreakerConfig;
}

export function evaluateCircuitBreaker(trades: ClosedTradeLite[], accountBalance: number, now: number, config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG): CircuitBreakerDecision {
  const valid = trades.filter((t) => Number.isFinite(t.closedAt) && Number.isFinite(t.realizedPnl) && t.closedAt <= now).sort((a, b) => a.closedAt - b.closedAt);
  const p = zonedParts(now, config.zone);
  const dayStart = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day }, config.zone);
  const dowMon = (p.weekday + 6) % 7;
  const weekStart = dayStart - dowMon * 86_400_000;
  const monthStart = zonedTimeToUtc({ year: p.year, month: p.month, day: 1 }, config.zone);
  const nextDay = dayStart + 86_400_000;
  const nextWeek = weekStart + 7 * 86_400_000;
  const nextMonth = zonedTimeToUtc({ year: p.month === 12 ? p.year + 1 : p.year, month: p.month === 12 ? 1 : p.month + 1, day: 1 }, config.zone);
  const sum = (from: number) => valid.filter((t) => t.closedAt >= from).reduce((s, t) => s + t.realizedPnl, 0);
  const dailyPnl = sum(dayStart);
  const weeklyPnl = sum(weekStart);
  const monthlyPnl = sum(monthStart);
  let consecutiveLosses = 0;
  for (let i = valid.length - 1; i >= 0; i--) {
    if (valid[i].realizedPnl < 0) consecutiveLosses++;
    else break;
  }
  const triggered: TriggeredRule[] = [];
  const pct = (v: number) => (accountBalance > 0 ? (-v / accountBalance) * 100 : 0);
  if (accountBalance > 0 && pct(dailyPnl) >= config.maxDailyLossPct) triggered.push({ rule: "max_daily_loss", state: "HALTED", detail: `Realised loss today ${pct(dailyPnl).toFixed(2)}% ≥ ${config.maxDailyLossPct}% limit`, activeUntil: nextDay });
  if (consecutiveLosses >= config.losingStreakN) {
    const lastLoss = valid[valid.length - 1].closedAt;
    const until = lastLoss + config.cooldownHours * 3_600_000;
    if (until > now) triggered.push({ rule: "losing_streak_cooldown", state: "COOLDOWN", detail: `${consecutiveLosses} consecutive losing trades — ${config.cooldownHours}h cooldown`, activeUntil: until });
  }
  if (accountBalance > 0 && pct(weeklyPnl) >= config.weeklyDrawdownPct) triggered.push({ rule: "weekly_drawdown_halt", state: "HALTED", detail: `Week-to-date loss ${pct(weeklyPnl).toFixed(2)}% ≥ ${config.weeklyDrawdownPct}%`, activeUntil: nextWeek });
  if (accountBalance > 0 && pct(monthlyPnl) >= config.monthlyDrawdownPct) triggered.push({ rule: "monthly_drawdown_halt", state: "HALTED", detail: `Month-to-date loss ${pct(monthlyPnl).toFixed(2)}% ≥ ${config.monthlyDrawdownPct}%`, activeUntil: nextMonth });
  const recommendation: CircuitState = triggered.some((t) => t.state === "HALTED") ? "HALTED" : triggered.some((t) => t.state === "COOLDOWN") ? "COOLDOWN" : "TRADING_ALLOWED";
  return { recommendation, triggered, metrics: { dailyPnl, weeklyPnl, monthlyPnl, consecutiveLosses, tradesScanned: valid.length }, asOf: now, config };
}

export type GateDecision = "GO" | "NO_GO" | "REVIEW_REQUIRED";

export interface GateInput {
  entryInWrittenPlan: boolean | null;
  stopPredefined: boolean | null;
  sizeWithinPlan: boolean | null;
  plannedRiskAmount: number | null;
  actualRiskAmount: number | null;
  recentClosedTrades: ClosedTradeLite[];
  revengeWindowHours?: number;
  marketRegime?: { zone: string; direction: "LONG" | "SHORT" | null } | null;
  circuitBreaker?: CircuitBreakerDecision | null;
  now: number;
}

export interface GateRuleResult {
  rule: string;
  passed: boolean | null; // null = unknown
  detail: string;
}

export interface GateResult {
  decision: GateDecision;
  rules: GateRuleResult[];
  asOf: number;
}

export function evaluateDisciplineGate(input: GateInput): GateResult {
  const rules: GateRuleResult[] = [];
  const bool = (v: boolean | null, rule: string, failMsg: string, passMsg: string) => {
    if (v === null) rules.push({ rule, passed: null, detail: "Not answered" });
    else rules.push({ rule, passed: v, detail: v ? passMsg : failMsg });
  };
  bool(input.entryInWrittenPlan, "entry_in_written_plan", "Entry is not part of a written plan", "Entry matches the written plan");
  bool(input.stopPredefined, "stop_predefined", "Stop-loss is not predefined", "Stop-loss defined before entry");
  bool(input.sizeWithinPlan, "size_within_plan", "Size is not confirmed within plan", "Size is within plan");
  const pr = input.plannedRiskAmount;
  const ar = input.actualRiskAmount;
  if (pr === null || ar === null || !Number.isFinite(pr) || !Number.isFinite(ar) || pr < 0 || ar < 0) rules.push({ rule: "risk_within_plan", passed: null, detail: "Planned and actual risk must both be finite, non-negative numbers" });
  else rules.push({ rule: "risk_within_plan", passed: ar <= pr, detail: ar <= pr ? `Actual risk ${ar.toFixed(2)} ≤ planned ${pr.toFixed(2)}` : `Actual risk ${ar.toFixed(2)} exceeds planned ${pr.toFixed(2)}` });
  const window = (input.revengeWindowHours ?? 24) * 3_600_000;
  const recentLoss = input.recentClosedTrades.find((t) => t.realizedPnl < 0 && input.now - t.closedAt <= window && t.closedAt <= input.now);
  rules.push({ rule: "no_revenge_window", passed: !recentLoss, detail: recentLoss ? `A losing trade closed ${Math.round((input.now - recentLoss.closedAt) / 3_600_000)}h ago — inside the ${input.revengeWindowHours ?? 24}h cooling window` : "No losing exit inside the cooling window" });
  if (input.marketRegime === undefined) rules.push({ rule: "market_regime", passed: null, detail: "Regime artifact not supplied" });
  else if (input.marketRegime === null) rules.push({ rule: "market_regime", passed: null, detail: "Regime unavailable (data coverage)" });
  else {
    const z = input.marketRegime.zone;
    const blocked = (z === "RISK_OFF" || z === "DEFENSIVE") && input.marketRegime.direction === "LONG";
    rules.push({ rule: "market_regime", passed: !blocked, detail: blocked ? `Regime is ${z}: new LONG exposure is flagged — review before proceeding` : `Regime ${z} does not block this order` });
  }
  if (input.circuitBreaker === undefined) rules.push({ rule: "circuit_breaker", passed: null, detail: "Circuit-breaker decision not supplied" });
  else if (input.circuitBreaker === null) rules.push({ rule: "circuit_breaker", passed: null, detail: "Circuit breaker could not be evaluated" });
  else rules.push({ rule: "circuit_breaker", passed: input.circuitBreaker.recommendation === "TRADING_ALLOWED", detail: input.circuitBreaker.recommendation === "TRADING_ALLOWED" ? "Account-level circuit breaker allows new risk" : `Circuit breaker is ${input.circuitBreaker.recommendation}: ${input.circuitBreaker.triggered.map((t) => t.detail).join("; ")}` });
  const anyFail = rules.some((r) => r.passed === false);
  const anyUnknown = rules.some((r) => r.passed === null);
  return { decision: anyFail ? "NO_GO" : anyUnknown ? "REVIEW_REQUIRED" : "GO", rules, asOf: input.now };
}

/** Portfolio heat: total open risk as % of account. */
export function portfolioHeat(openRisks: number[], accountBalance: number): { heatPct: number; status: "ok" | "elevated" | "excessive" } {
  const total = openRisks.filter(Number.isFinite).reduce((a, b) => a + b, 0);
  const heatPct = accountBalance > 0 ? (total / accountBalance) * 100 : 0;
  return { heatPct, status: heatPct > 8 ? "excessive" : heatPct > 6 ? "elevated" : "ok" };
}

/**
 * Setup monitoring: pure state machine that tracks a saved trade plan against incoming
 * prices. It records when price reaches the entry zone, each target and the stop, tracks
 * excursion in R, and keeps every event for history. It never places or claims to place
 * an order — every message says "level reached", never "filled" or "executed".
 */
import type { Direction, TradeSetup } from "../types";
import { hashString } from "../math";

export type MonitorStatus = "watching" | "entry_reached" | "tp1_reached" | "tp2_reached" | "tp3_reached" | "stopped" | "expired" | "cancelled" | "closed";
export type MonitorEventType = "entry_reached" | "tp1_reached" | "tp2_reached" | "tp3_reached" | "stop_reached" | "expired" | "cancelled" | "closed";

export interface MonitorEvent {
  id: string;
  type: MonitorEventType;
  price: number;
  time: number;
  message: string;
  rMultiple?: number;
}

export interface MonitoredSetup {
  id: string;
  setupId: string;
  assetId: string;
  symbol: string;
  direction: Direction;
  timeframe: TradeSetup["timeframe"];
  setup: TradeSetup;
  status: MonitorStatus;
  final: boolean;
  events: MonitorEvent[];
  entryReached: boolean;
  entryPrice: number | null;
  entryTime: number | null;
  hits: { tp1: boolean; tp2: boolean; tp3: boolean; stop: boolean };
  lastPrice: number | null;
  lastCheckedAt: number | null;
  /** Maximum favourable / adverse excursion in R since the entry zone was reached. */
  mfeR: number;
  maeR: number;
  /** Outcome in R once final (equal-thirds scale-out convention; see docs). */
  outcomeR: number | null;
  createdAt: number;
  closedAt: number | null;
  source: "saved" | "auto" | "manual";
  note?: string;
}

const EXEC_DISCLAIMER = " No order was placed — this terminal only monitors levels.";

export function createMonitored(setup: TradeSetup, now: number, source: MonitoredSetup["source"] = "saved"): MonitoredSetup {
  if (setup.status === "NO TRADE" || !setup.direction || setup.stopLoss === null || setup.targets.length < 3) throw new Error("Only setups with a direction, stop and three targets can be monitored");
  return {
    id: `mon_${hashString(`${setup.id}:${now}`)}`,
    setupId: setup.id,
    assetId: setup.assetId,
    symbol: setup.symbol,
    direction: setup.direction,
    timeframe: setup.timeframe,
    setup,
    status: "watching",
    final: false,
    events: [],
    entryReached: false,
    entryPrice: null,
    entryTime: null,
    hits: { tp1: false, tp2: false, tp3: false, stop: false },
    lastPrice: null,
    lastCheckedAt: null,
    mfeR: 0,
    maeR: 0,
    outcomeR: null,
    createdAt: now,
    closedAt: null,
    source,
  };
}

function rAt(m: MonitoredSetup, price: number): number {
  const entry = m.entryPrice ?? m.setup.entry.mid;
  const unit = Math.abs(entry - (m.setup.stopLoss as number));
  if (unit === 0) return 0;
  return m.direction === "LONG" ? (price - entry) / unit : (entry - price) / unit;
}

function ladderOutcome(m: MonitoredSetup, remainingR: number): number {
  const hits = [m.hits.tp1, m.hits.tp2, m.hits.tp3];
  let realized = 0;
  let n = 0;
  hits.forEach((h, i) => {
    if (h) {
      realized += m.setup.targets[i].rMultiple / 3;
      n++;
    }
  });
  return Math.round((realized + ((3 - n) / 3) * remainingR) * 100) / 100;
}

function event(type: MonitorEventType, price: number, time: number, message: string, rMultiple?: number): MonitorEvent {
  return { id: `ev_${hashString(`${type}:${time}:${price}`)}`, type, price, time, message, rMultiple };
}

/** Apply one observed price. Returns the updated record and any new events (for alerts). */
export function applyPrice(input: MonitoredSetup, price: number, time: number): { next: MonitoredSetup; newEvents: MonitorEvent[] } {
  if (input.final || !Number.isFinite(price) || price <= 0) return { next: input, newEvents: [] };
  const m: MonitoredSetup = { ...input, hits: { ...input.hits }, events: [...input.events], lastPrice: price, lastCheckedAt: time };
  const s = m.setup;
  const stop = s.stopLoss as number;
  const long = m.direction === "LONG";
  const newEvents: MonitorEvent[] = [];
  const push = (e: MonitorEvent) => {
    m.events.push(e);
    newEvents.push(e);
  };
  const fmt = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 8 });

  if (!m.entryReached) {
    if (time > s.expiresAt) {
      m.status = "expired";
      m.final = true;
      m.closedAt = time;
      push(event("expired", price, time, `${s.symbol} ${m.direction} plan expired before price reached the entry zone ${fmt(s.entry.low)}–${fmt(s.entry.high)}.`));
      return { next: m, newEvents };
    }
    const inZone = price >= s.entry.low && price <= s.entry.high;
    const through = long ? price < s.entry.low : price > s.entry.high; // moved through the zone without a tick inside it
    if (inZone || through) {
      m.entryReached = true;
      m.entryPrice = inZone ? price : long ? s.entry.low : s.entry.high;
      m.entryTime = time;
      m.status = "entry_reached";
      push(event("entry_reached", m.entryPrice, time, `${s.symbol} price reached the ${m.direction} entry zone ${fmt(s.entry.low)}–${fmt(s.entry.high)} (${fmt(m.entryPrice)}).${EXEC_DISCLAIMER}`));
    } else return { next: m, newEvents };
  }

  const r = rAt(m, price);
  m.mfeR = Math.max(m.mfeR, r);
  m.maeR = Math.min(m.maeR, r);
  const stopHit = long ? price <= stop : price >= stop;
  if (stopHit) {
    m.hits.stop = true;
    m.status = "stopped";
    m.final = true;
    m.closedAt = time;
    m.outcomeR = ladderOutcome(m, -1);
    push(event("stop_reached", price, time, `${s.symbol} price reached the stop level ${fmt(stop)} (${fmt(price)}). Plan invalidated; ${m.hits.tp1 ? "partial targets were reached earlier" : "no target was reached"}.${EXEC_DISCLAIMER}`, m.outcomeR));
    return { next: m, newEvents };
  }
  const keys: ("tp1" | "tp2" | "tp3")[] = ["tp1", "tp2", "tp3"];
  for (let i = 0; i < 3; i++) {
    const k = keys[i];
    if (m.hits[k]) continue;
    const t = s.targets[i];
    const reached = long ? price >= t.price : price <= t.price;
    if (!reached) break; // targets are sequential
    m.hits[k] = true;
    m.status = `${k}_reached` as MonitorStatus;
    push(event(`${k}_reached` as MonitorEventType, price, time, `${s.symbol} price reached ${t.label} ${fmt(t.price)} (+${t.rMultiple.toFixed(2)}R) — ${t.basis}.${EXEC_DISCLAIMER}`, t.rMultiple));
    if (k === "tp3") {
      m.final = true;
      m.closedAt = time;
      m.outcomeR = ladderOutcome(m, s.targets[2].rMultiple);
    }
  }
  return { next: m, newEvents };
}

export function cancelMonitored(input: MonitoredSetup, time: number, reason = "Cancelled by user"): MonitoredSetup {
  if (input.final) return input;
  const m: MonitoredSetup = { ...input, events: [...input.events], status: "cancelled", final: true, closedAt: time };
  m.outcomeR = m.entryReached && m.lastPrice !== null ? ladderOutcome(m, rAt(m, m.lastPrice)) : null;
  m.events.push(event("cancelled", m.lastPrice ?? 0, time, `${reason}.`));
  return m;
}

export function closeMonitored(input: MonitoredSetup, price: number, time: number): MonitoredSetup {
  if (input.final) return input;
  const m: MonitoredSetup = { ...input, events: [...input.events], status: "closed", final: true, closedAt: time, lastPrice: price };
  m.outcomeR = m.entryReached ? ladderOutcome(m, rAt(m, price)) : null;
  m.events.push(event("closed", price, time, `${m.symbol} plan closed manually at ${price} (${m.outcomeR !== null ? `${m.outcomeR >= 0 ? "+" : ""}${m.outcomeR.toFixed(2)}R` : "never entered"}).${EXEC_DISCLAIMER}`, m.outcomeR ?? undefined));
  return m;
}

export function monitorSummary(list: MonitoredSetup[]) {
  const active = list.filter((m) => !m.final);
  const finished = list.filter((m) => m.final);
  const outcomes = finished.map((m) => m.outcomeR).filter((r): r is number => r !== null);
  return {
    active: active.length,
    watching: active.filter((m) => !m.entryReached).length,
    entered: active.filter((m) => m.entryReached).length,
    finished: finished.length,
    stopped: finished.filter((m) => m.status === "stopped").length,
    completed: finished.filter((m) => m.status === "tp3_reached").length,
    expired: finished.filter((m) => m.status === "expired").length,
    avgOutcomeR: outcomes.length ? Math.round((outcomes.reduce((a, b) => a + b, 0) / outcomes.length) * 100) / 100 : null,
  };
}

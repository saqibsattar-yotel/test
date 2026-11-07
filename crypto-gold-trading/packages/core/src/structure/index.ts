/**
 * Market structure: swing points, HH/HL/LH/LL classification, breakouts, support &
 * resistance clustering, Fibonacci levels, liquidity zones, previous-period and
 * session ranges. Everything here is computed from candles only — no opinions.
 */
import type { Candle, Level, Timeframe } from "../types";
import { zonedParts, startOfUtcDay, startOfUtcWeek } from "../time";

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  type: "high" | "low";
}

/** Fractal pivots: a high (low) that exceeds `left` bars before and `right` bars after. */
export function findSwings(candles: Candle[], left = 2, right = 2): SwingPoint[] {
  const swings: SwingPoint[] = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swings.push({ index: i, time: c.time, price: c.high, type: "high" });
    if (isLow) swings.push({ index: i, time: c.time, price: c.low, type: "low" });
  }
  return swings;
}

export type StructureTrend = "uptrend" | "downtrend" | "range" | "transition";

export interface StructureSummary {
  trend: StructureTrend;
  /** Sequence labels of the most recent swings, oldest -> newest, e.g. ["HL","HH","HL","HH"]. */
  sequence: string[];
  lastSwingHigh: SwingPoint | null;
  lastSwingLow: SwingPoint | null;
  prevSwingHigh: SwingPoint | null;
  prevSwingLow: SwingPoint | null;
  /** Break of structure on the latest close. */
  breakout: { type: "bullish" | "bearish"; level: number; barsAgo: number } | null;
  higherHighs: number;
  higherLows: number;
  lowerHighs: number;
  lowerLows: number;
  description: string;
}

export function classifyStructure(candles: Candle[], swings: SwingPoint[], lookbackSwings = 6): StructureSummary {
  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");
  const recentHighs = highs.slice(-lookbackSwings);
  const recentLows = lows.slice(-lookbackSwings);
  let hh = 0;
  let lh = 0;
  let hl = 0;
  let ll = 0;
  const seq: { time: number; label: string }[] = [];
  for (let i = 1; i < recentHighs.length; i++) {
    if (recentHighs[i].price > recentHighs[i - 1].price) {
      hh++;
      seq.push({ time: recentHighs[i].time, label: "HH" });
    } else {
      lh++;
      seq.push({ time: recentHighs[i].time, label: "LH" });
    }
  }
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i].price > recentLows[i - 1].price) {
      hl++;
      seq.push({ time: recentLows[i].time, label: "HL" });
    } else {
      ll++;
      seq.push({ time: recentLows[i].time, label: "LL" });
    }
  }
  seq.sort((a, b) => a.time - b.time);
  const lastLabels = seq.slice(-4).map((s) => s.label);
  const bullishRecent = lastLabels.filter((l) => l === "HH" || l === "HL").length;
  const bearishRecent = lastLabels.filter((l) => l === "LH" || l === "LL").length;
  let trend: StructureTrend = "range";
  if (lastLabels.length >= 3) {
    if (bullishRecent >= 3) trend = "uptrend";
    else if (bearishRecent >= 3) trend = "downtrend";
    else if (bullishRecent === 2 && bearishRecent === 2) trend = "transition";
  }

  const lastSwingHigh = highs[highs.length - 1] ?? null;
  const lastSwingLow = lows[lows.length - 1] ?? null;
  const prevSwingHigh = highs[highs.length - 2] ?? null;
  const prevSwingLow = lows[lows.length - 2] ?? null;

  let breakout: StructureSummary["breakout"] = null;
  const lastClose = candles[candles.length - 1]?.close;
  if (lastClose !== undefined) {
    // Look for the most recent close through the last confirmed swing extreme.
    if (lastSwingHigh) {
      for (let i = candles.length - 1; i > lastSwingHigh.index && i >= candles.length - 10; i--) {
        if (candles[i].close > lastSwingHigh.price && (i === 0 || candles[i - 1].close <= lastSwingHigh.price)) {
          breakout = { type: "bullish", level: lastSwingHigh.price, barsAgo: candles.length - 1 - i };
          break;
        }
      }
    }
    if (!breakout && lastSwingLow) {
      for (let i = candles.length - 1; i > lastSwingLow.index && i >= candles.length - 10; i--) {
        if (candles[i].close < lastSwingLow.price && (i === 0 || candles[i - 1].close >= lastSwingLow.price)) {
          breakout = { type: "bearish", level: lastSwingLow.price, barsAgo: candles.length - 1 - i };
          break;
        }
      }
    }
    // A breakout is only "live" if price is still beyond the level.
    if (breakout && ((breakout.type === "bullish" && lastClose < breakout.level) || (breakout.type === "bearish" && lastClose > breakout.level))) {
      breakout = null;
    }
  }

  const description =
    trend === "uptrend"
      ? `Higher highs and higher lows (${hh} HH / ${hl} HL in the recent swings)`
      : trend === "downtrend"
        ? `Lower highs and lower lows (${lh} LH / ${ll} LL in the recent swings)`
        : trend === "transition"
          ? "Mixed swing sequence — structure is transitioning"
          : "No clear higher-high/lower-low sequence — range-bound";

  return { trend, sequence: lastLabels, lastSwingHigh, lastSwingLow, prevSwingHigh, prevSwingLow, breakout, higherHighs: hh, higherLows: hl, lowerHighs: lh, lowerLows: ll, description };
}

export interface SRLevel extends Level {
  zoneLow: number;
  zoneHigh: number;
}

/**
 * Clusters swing highs/lows into horizontal zones. Tolerance scales with ATR so that
 * a $30 band on gold and a $300 band on BTC are treated comparably.
 */
export function supportResistance(candles: Candle[], swings: SwingPoint[], atrValue: number, timeframe?: Timeframe, maxLevels = 8): { support: SRLevel[]; resistance: SRLevel[] } {
  if (candles.length === 0) return { support: [], resistance: [] };
  const price = candles[candles.length - 1].close;
  const tol = Math.max(atrValue * 0.35, price * 0.0015);
  const points = [...swings].sort((a, b) => a.price - b.price);
  const clusters: { prices: number[]; times: number[]; types: Set<string> }[] = [];
  for (const p of points) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(p.price - c.prices[c.prices.length - 1]) <= tol) {
      c.prices.push(p.price);
      c.times.push(p.time);
      c.types.add(p.type);
    } else clusters.push({ prices: [p.price], times: [p.time], types: new Set([p.type]) });
  }
  const now = candles[candles.length - 1].time;
  const span = Math.max(1, now - candles[0].time);
  const levels: SRLevel[] = clusters.map((c) => {
    const mid = c.prices.reduce((a, b) => a + b, 0) / c.prices.length;
    const touches = c.prices.length;
    const lastTouched = Math.max(...c.times);
    const recency = 1 - (now - lastTouched) / span; // 0 old .. 1 recent
    const roleFlip = c.types.size > 1 ? 0.1 : 0;
    const strength = Math.min(1, 0.25 + Math.min(touches, 5) * 0.12 + recency * 0.2 + roleFlip);
    const below = mid < price;
    return {
      price: mid,
      zoneLow: Math.min(...c.prices),
      zoneHigh: Math.max(...c.prices),
      kind: below ? "support" : "resistance",
      label: `${below ? "Support" : "Resistance"} ${touches > 1 ? `(${touches} touches)` : ""}`.trim(),
      strength,
      timeframe,
      touches,
      lastTouched,
    };
  });
  const support = levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price).slice(0, maxLevels);
  const resistance = levels.filter((l) => l.price >= price).sort((a, b) => a.price - b.price).slice(0, maxLevels);
  return { support, resistance };
}

export interface FibLevels {
  impulseLow: number;
  impulseHigh: number;
  direction: "up" | "down";
  retracements: { ratio: number; price: number }[];
  extensions: { ratio: number; price: number }[];
}

/** Fibonacci retracements of the last impulse and extensions projected beyond it. */
export function fibonacci(impulseLow: number, impulseHigh: number, direction: "up" | "down"): FibLevels {
  const range = impulseHigh - impulseLow;
  const retRatios = [0.236, 0.382, 0.5, 0.618, 0.786];
  const extRatios = [1.272, 1.618, 2.0, 2.618];
  const retracements = retRatios.map((r) => ({ ratio: r, price: direction === "up" ? impulseHigh - range * r : impulseLow + range * r }));
  const extensions = extRatios.map((r) => ({ ratio: r, price: direction === "up" ? impulseLow + range * r : impulseHigh - range * r }));
  return { impulseLow, impulseHigh, direction, retracements, extensions };
}

/** Identify the most recent impulse leg from swing points (last significant low->high or high->low). */
export function lastImpulse(swings: SwingPoint[]): { low: SwingPoint; high: SwingPoint; direction: "up" | "down" } | null {
  if (swings.length < 2) return null;
  const sorted = [...swings].sort((a, b) => a.index - b.index);
  const lastSwing = sorted[sorted.length - 1];
  // find the most recent opposite-type swing before it
  for (let i = sorted.length - 2; i >= 0; i--) {
    if (sorted[i].type !== lastSwing.type) {
      const other = sorted[i];
      if (lastSwing.type === "high") return { low: other, high: lastSwing, direction: "up" };
      return { low: lastSwing, high: other, direction: "down" };
    }
  }
  return null;
}

/** Psychological round-number levels around the current price. */
export function roundNumberLevels(price: number, step: number, count = 3): Level[] {
  const out: Level[] = [];
  const base = Math.floor(price / step) * step;
  for (let i = -count; i <= count; i++) {
    const p = base + i * step;
    if (p <= 0 || Math.abs(p - price) < step * 0.05) continue;
    const major = Math.abs(p / (step * 5) - Math.round(p / (step * 5))) < 1e-9;
    out.push({ price: Number(p.toFixed(8)), kind: "round_number", label: `Round number ${major ? "(major)" : ""}`.trim(), strength: major ? 0.45 : 0.3 });
  }
  return out;
}

/**
 * Liquidity zones: clusters of equal highs / equal lows where resting stops are likely.
 * Returned as levels above (buy-side liquidity) and below (sell-side liquidity) price.
 */
export function liquidityZones(candles: Candle[], swings: SwingPoint[], atrValue: number): Level[] {
  if (candles.length === 0) return [];
  const price = candles[candles.length - 1].close;
  const tol = Math.max(atrValue * 0.15, price * 0.0008);
  const out: Level[] = [];
  for (const type of ["high", "low"] as const) {
    const pts = swings.filter((s) => s.type === type).sort((a, b) => a.price - b.price);
    let i = 0;
    while (i < pts.length) {
      let j = i;
      while (j + 1 < pts.length && pts[j + 1].price - pts[i].price <= tol) j++;
      if (j > i) {
        const group = pts.slice(i, j + 1);
        const level = type === "high" ? Math.max(...group.map((g) => g.price)) : Math.min(...group.map((g) => g.price));
        out.push({
          price: level,
          kind: "liquidity",
          label: type === "high" ? `Equal highs (${group.length}) — buy-side liquidity` : `Equal lows (${group.length}) — sell-side liquidity`,
          strength: Math.min(1, 0.4 + group.length * 0.15),
          touches: group.length,
          lastTouched: Math.max(...group.map((g) => g.time)),
        });
      }
      i = j + 1;
    }
  }
  return out.sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
}

export interface PeriodLevels {
  prevDayHigh: number | null;
  prevDayLow: number | null;
  prevDayClose: number | null;
  prevWeekHigh: number | null;
  prevWeekLow: number | null;
  /** Range of the current (incomplete) UTC day so far. */
  todayHigh: number | null;
  todayLow: number | null;
  asOf: number;
}

/** Previous UTC day / ISO week extremes from intraday candles (any timeframe ≤ 1d). */
export function periodLevels(candles: Candle[], now: number): PeriodLevels {
  const dayStart = startOfUtcDay(now);
  const prevDayStart = dayStart - 86_400_000;
  const weekStart = startOfUtcWeek(now);
  const prevWeekStart = weekStart - 7 * 86_400_000;
  const agg = (from: number, to: number) => {
    let hi = -Infinity;
    let lo = Infinity;
    let close: number | null = null;
    for (const c of candles) {
      if (c.time >= from && c.time < to) {
        if (c.high > hi) hi = c.high;
        if (c.low < lo) lo = c.low;
        close = c.close;
      }
    }
    return hi === -Infinity ? { hi: null, lo: null, close: null } : { hi, lo, close };
  };
  const pd = agg(prevDayStart, dayStart);
  const pw = agg(prevWeekStart, weekStart);
  const td = agg(dayStart, now + 1);
  return { prevDayHigh: pd.hi, prevDayLow: pd.lo, prevDayClose: pd.close, prevWeekHigh: pw.hi, prevWeekLow: pw.lo, todayHigh: td.hi, todayLow: td.lo, asOf: now };
}

export interface SessionDef {
  name: "Asia" | "London" | "New York";
  zone: string;
  startHour: number; // local hour (inclusive)
  startMinute: number;
  endHour: number; // local hour (exclusive)
  endMinute: number;
}

/**
 * Session definitions. Asia is pinned to UTC (Tokyo has no DST and the window
 * spans Sydney/Tokyo); London and New York follow their local clocks so DST is
 * handled correctly. These are conventions, not exchange hours.
 */
export const SESSIONS: SessionDef[] = [
  { name: "Asia", zone: "UTC", startHour: 0, startMinute: 0, endHour: 8, endMinute: 0 },
  { name: "London", zone: "Europe/London", startHour: 8, startMinute: 0, endHour: 16, endMinute: 30 },
  { name: "New York", zone: "America/New_York", startHour: 8, startMinute: 0, endHour: 17, endMinute: 0 },
];

export interface SessionRange {
  name: SessionDef["name"];
  high: number | null;
  low: number | null;
  open: number | null;
  close: number | null;
  bars: number;
  /** Whether the session window for the reference day is still in progress at `now`. */
  inProgress: boolean;
  startsAt: number;
  endsAt: number;
}

function inSession(time: number, def: SessionDef): boolean {
  const p = zonedParts(time, def.zone);
  const minutes = p.hour * 60 + p.minute;
  const start = def.startHour * 60 + def.startMinute;
  const end = def.endHour * 60 + def.endMinute;
  return minutes >= start && minutes < end;
}

/**
 * Session ranges for the UTC trading day that contains `now` (or the previous day
 * when `dayOffset` = -1). Candles should be ≤ 1h.
 */
export function sessionRanges(candles: Candle[], now: number, dayOffset = 0): SessionRange[] {
  const dayStart = startOfUtcDay(now) + dayOffset * 86_400_000;
  const dayEnd = dayStart + 86_400_000;
  return SESSIONS.map((def) => {
    let hi = -Infinity;
    let lo = Infinity;
    let open: number | null = null;
    let close: number | null = null;
    let bars = 0;
    let first = Infinity;
    let lastT = -Infinity;
    for (const c of candles) {
      if (c.time < dayStart || c.time >= dayEnd) continue;
      if (!inSession(c.time, def)) continue;
      bars++;
      if (open === null) open = c.open;
      close = c.close;
      if (c.high > hi) hi = c.high;
      if (c.low < lo) lo = c.low;
      if (c.time < first) first = c.time;
      if (c.time > lastT) lastT = c.time;
    }
    // Window bounds expressed for display: scan the day in 15-minute steps.
    let startsAt = NaN;
    let endsAt = NaN;
    for (let t = dayStart; t < dayEnd; t += 15 * 60_000) {
      const inside = inSession(t, def);
      if (inside && Number.isNaN(startsAt)) startsAt = t;
      if (!inside && !Number.isNaN(startsAt) && Number.isNaN(endsAt)) endsAt = t;
    }
    if (Number.isNaN(endsAt)) endsAt = dayEnd;
    return { name: def.name, high: bars ? hi : null, low: bars ? lo : null, open, close, bars, inProgress: now >= startsAt && now < endsAt, startsAt, endsAt };
  });
}

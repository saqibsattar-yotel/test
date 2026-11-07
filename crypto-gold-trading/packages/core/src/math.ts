/** Small numeric helpers shared across the core package. */

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function stddev(values: number[], sample = true): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return Math.sqrt(acc / (sample ? n - 1 : n));
}

export function percentileRank(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0.5;
  let below = 0;
  for (const v of sorted) if (v <= value) below++;
  return below / sorted.length;
}

export function roundTo(v: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round((v + Number.EPSILON) * f) / f;
}

/** Floors `value` to a multiple of `step` with tolerance for binary float noise. */
export function floorToStep(value: number, step: number): number {
  if (step <= 0) return value;
  const q = Math.floor(value / step + 1e-9);
  return roundTo(q * step, decimalsOf(step));
}

/** Rounds to the nearest multiple of `step` (used for tick alignment). */
export function roundToStep(value: number, step: number): number {
  if (step <= 0) return value;
  return roundTo(Math.round(value / step) * step, decimalsOf(step));
}

export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = step.toString();
  if (s.includes("e-")) return parseInt(s.split("e-")[1], 10);
  const idx = s.indexOf(".");
  return idx === -1 ? 0 : s.length - idx - 1;
}

export function pctChange(from: number, to: number): number {
  if (!isFiniteNumber(from) || from === 0) return NaN;
  return ((to - from) / from) * 100;
}

export function last<T>(arr: T[], offset = 0): T | undefined {
  return arr[arr.length - 1 - offset];
}

/** Deterministic hash (FNV-1a) used for stable IDs. */
export function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

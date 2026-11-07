/**
 * Rule-based explainer. Produces honest, numeric narrative from computed results.
 * Used (a) as the fallback when no LLM key is configured and (b) as the fact sheet that
 * the LLM is constrained to when it is configured.
 */
import type { TradeSetup } from "../types";
import type { MtfResult } from "../mtf";
import type { CryptoRegimeResult } from "../regime/crypto";
import type { GoldRegimeResult } from "../regime/gold";

export function explainSetup(setup: TradeSetup, mtf?: MtfResult | null): string[] {
  const out: string[] = [];
  if (setup.status === "NO TRADE") {
    out.push(`${setup.symbol} on the ${setup.timeframe}: NO TRADE.`);
    out.push(...setup.rationale);
    if (mtf) out.push(`Multi-timeframe read: ${mtf.summary[0]}`);
    return out;
  }
  out.push(`${setup.symbol} ${setup.direction} (${setup.setupType?.replace(/_/g, " ")}) on the ${setup.timeframe} with ${setup.contextTimeframe} context — status ${setup.status}, quality ${setup.qualityScore}/100 (${setup.confidence} confidence).`);
  out.push(...setup.rationale);
  if (setup.supporting.length) out.push(`Supporting evidence: ${setup.supporting.map((e) => e.text).join("; ")}.`);
  if (setup.opposing.length) out.push(`Opposing evidence: ${setup.opposing.map((e) => e.text).join("; ")}.`);
  if (setup.entryConditions.length) out.push(`Before entry: ${setup.entryConditions.join("; ")}.`);
  out.push(`Invalidation: ${setup.invalidation}`);
  if (mtf?.conflicts.length) out.push(`Timeframe conflicts: ${mtf.conflicts[0]}`);
  out.push(`Expected hold ${setup.expectedHold}; setup expires ${new Date(setup.expiresAt).toISOString()} if not triggered.`);
  return out;
}

export function explainCryptoRegime(r: CryptoRegimeResult): string[] {
  if (r.score === null) return [`Crypto regime: UNKNOWN — ${r.guidance}.`];
  const sorted = [...r.components].filter((c) => c.dataAvailable).sort((a, b) => Math.abs(b.score - 50) * (r.effectiveWeights[b.id] ?? 0) - Math.abs(a.score - 50) * (r.effectiveWeights[a.id] ?? 0));
  const drivers = sorted.slice(0, 2).map((c) => `${c.label} (${c.score}/100): ${c.signal}`);
  const missing = r.components.filter((c) => !c.dataAvailable).map((c) => c.label);
  const out = [`Crypto regime ${r.zone} with a composite score of ${r.score}/100 — ${r.guidance}.`, `Main drivers: ${drivers.join(" | ")}.`];
  if (missing.length) out.push(`Components without data (weight redistributed): ${missing.join(", ")}. Confidence is reduced accordingly.`);
  out.push("This score describes market conditions; it is not a probability that any trade will work.");
  return out;
}

export function explainGoldRegime(r: GoldRegimeResult): string[] {
  if (r.score === null) return [`Gold posture: UNKNOWN — ${r.guidance}.`];
  const avail = r.components.filter((c) => c.dataAvailable);
  const out = [`Gold macro-technical posture ${r.zone} (${r.score}/100) — ${r.guidance}.`];
  for (const c of avail) out.push(`${c.label}: ${c.signal}.`);
  const missing = r.components.filter((c) => !c.dataAvailable);
  if (missing.length) out.push(`Unavailable inputs: ${missing.map((m) => `${m.label} (${m.signal})`).join("; ")}.`);
  return out;
}

export function explainMtf(m: MtfResult): string[] {
  const out = [...m.summary];
  if (m.conflicts.length) out.push(`Conflicts: ${m.conflicts.join(" / ")}`);
  if (m.entryArea) out.push(`Potential entry area ${m.entryArea.low.toFixed(2)}–${m.entryArea.high.toFixed(2)} (${m.entryArea.basis}).`);
  if (m.confirmations.length) out.push(`Confirmation needed: ${m.confirmations.join("; ")}.`);
  if (m.invalidations.length) out.push(`Invalidation: ${m.invalidations.join("; ")}.`);
  out.push(m.worthConsidering ? "Worth considering a trade plan — subject to risk sizing and the discipline gate." : "Not worth forcing a trade right now.");
  return out;
}

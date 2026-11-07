import type { ComponentResult } from "@terminal/core";
import { Meter, Tooltip, type Tone } from "@/components/ui";
import { cls } from "@/lib/format";

export function zoneTone(zone: string): Tone {
  switch (zone) {
    case "RISK_ON":
    case "CONSTRUCTIVE":
      return "bull";
    case "RISK_OFF":
    case "DEFENSIVE":
      return "bear";
    case "NEUTRAL":
    case "MIXED":
      return "warning";
    default:
      return "muted";
  }
}

export function RegimeMeter({ score, zone, components, effectiveWeights, compact = false }: { score: number | null; zone: string; components: ComponentResult[]; effectiveWeights?: Record<string, number>; compact?: boolean }) {
  const tone = zoneTone(zone);
  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold text-ink-1">{score === null ? "—" : score.toFixed(1)}</span>
            <span className="text-xs text-ink-3">/ 100</span>
          </div>
          <span className={cls("text-xs font-semibold tracking-wide", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : tone === "warning" ? "text-warn" : "text-ink-3")}>{zone.replace("_", " ")}</span>
        </div>
        <div className="text-[10.5px] text-ink-3 text-right hidden sm:block">
          <div>0–39 risk-off · 40–79 neutral · 80+ risk-on</div>
          <div>Descriptive heuristic, not a win probability</div>
        </div>
      </div>
      <Meter value={score} tone={tone} label="Regime score" thresholds={[{ at: 40, label: "40" }, { at: 80, label: "80" }]} />
      {!compact && (
        <ul className="space-y-2 pt-1">
          {components.map((c) => {
            const w = effectiveWeights?.[c.id] ?? c.weight;
            const t: Tone = !c.dataAvailable ? "muted" : c.score >= 60 ? "bull" : c.score <= 40 ? "bear" : "warning";
            return (
              <li key={c.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 items-center">
                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-ink-1 truncate">{c.label}</span>
                    <span className="text-[10.5px] text-ink-3 tabular shrink-0">w {(w * 100).toFixed(0)}%</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-surface-3 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${c.dataAvailable ? c.score : 0}%`, background: t === "bull" ? "var(--bull)" : t === "bear" ? "var(--bear)" : t === "warning" ? "var(--warning)" : "var(--ink-3)" }} />
                  </div>
                </div>
                <Tooltip content={c.signal}>
                  <span className={cls("text-sm font-semibold tabular w-9 text-right cursor-help", t === "bull" ? "text-bull" : t === "bear" ? "text-bear" : t === "warning" ? "text-warn" : "text-ink-3")}>{c.dataAvailable ? c.score : "n/a"}</span>
                </Tooltip>
                <p className="col-span-2 text-[11px] leading-snug text-ink-3 -mt-0.5">{c.signal}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

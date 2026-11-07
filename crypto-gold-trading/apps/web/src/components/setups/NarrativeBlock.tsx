import { Badge } from "@/components/ui";
import type { Narrative } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { useUi } from "@/lib/store";

export function NarrativeBlock({ narrative, compact = false }: { narrative: Narrative; compact?: boolean }) {
  const tz = useUi((s) => s.timezone);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-[11px] text-ink-3">
        <Badge tone={narrative.mode === "llm" ? "accent" : "neutral"} size="sm">
          {narrative.mode === "llm" ? `Claude · ${narrative.model}` : "Rule-based explainer"}
        </Badge>
        <Badge tone={narrative.grounded ? "bull" : "warning"} size="sm">
          {narrative.grounded ? "numbers grounded" : "grounding warning"}
        </Badge>
        {narrative.factsAsOf && <span>facts as of {fmtDateTime(narrative.factsAsOf, tz)}</span>}
      </div>
      {narrative.warning && <p className="text-xs text-warn">{narrative.warning}</p>}
      <div className={compact ? "space-y-1.5" : "space-y-2.5"}>
        {narrative.paragraphs.map((p, i) => (
          <p key={i} className={`${compact ? "text-xs" : "text-sm"} leading-relaxed text-ink-2`}>
            {p}
          </p>
        ))}
      </div>
      {!compact && <p className="text-[10.5px] text-ink-3">{narrative.disclaimer}</p>}
    </div>
  );
}

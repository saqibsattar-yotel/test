import type { TimeframeAnalysis } from "@terminal/core";
import { Tooltip } from "@/components/ui";
import { cls } from "@/lib/format";

export function MtfMatrix({ perTimeframe, onSelect, selected }: { perTimeframe: TimeframeAnalysis[]; onSelect?: (tf: TimeframeAnalysis["timeframe"]) => void; selected?: string }) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(1, perTimeframe.length)}, minmax(0, 1fr))` }}>
      {perTimeframe.map((p) => {
        const tone = p.bias === "bullish" ? "bull" : p.bias === "bearish" ? "bear" : "neutral";
        return (
          <Tooltip key={p.timeframe} content={<ul className="list-disc pl-4 space-y-0.5">{p.notes.slice(0, 5).map((n, i) => <li key={i}>{n}</li>)}</ul>}>
            <button onClick={() => onSelect?.(p.timeframe)} className={cls("w-full text-left rounded-lg border p-2.5 transition-colors", selected === p.timeframe ? "border-accent" : "border-line hover:border-line-strong", tone === "bull" ? "bg-bull-soft" : tone === "bear" ? "bg-bear-soft" : "bg-surface-2")}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-ink-1">{p.timeframe}</span>
                {p.quality.stale && <span className="text-[10px] text-warn">stale</span>}
              </div>
              <div className={cls("text-sm font-semibold mt-1 capitalize", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-ink-2")}>{p.bias}</div>
              <div className="mt-1.5 h-1 rounded-full bg-page/60 overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${p.strength}%`, background: tone === "bull" ? "var(--bull)" : tone === "bear" ? "var(--bear)" : "var(--ink-3)" }} />
              </div>
              <div className="mt-1 text-[10.5px] text-ink-3 capitalize truncate">{p.trend.replace("_", " ")} · {p.strength}%</div>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

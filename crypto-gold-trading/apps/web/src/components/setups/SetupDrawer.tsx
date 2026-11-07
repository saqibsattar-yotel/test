import { useState } from "react";
import { Sparkles } from "lucide-react";
import type { AssetId, Timeframe, TradeSetup } from "@terminal/core";
import { Badge, Button, DataNotice, Disclaimer, Drawer, SkeletonBlock, SourceBadge } from "@/components/ui";
import { PriceChart, DEFAULT_OVERLAYS } from "@/components/charts/PriceChart";
import { RRLadder } from "@/components/charts/RRLadder";
import { EvidenceList, StatusBadge } from "./SetupCard";
import { SetupTransparency } from "./Transparency";
import { useCandles, useNarrativeMutation, useSetupDetail, useSettings } from "@/lib/queries";
import { fmtDateTime, fmtPrice, setupTypeLabel } from "@/lib/format";
import { useUi } from "@/lib/store";
import { NarrativeBlock } from "@/components/setups/NarrativeBlock";

export function SetupDrawer({ assetId, timeframe, onClose }: { assetId: AssetId | null; timeframe: Timeframe; onClose: () => void }) {
  const settings = useSettings();
  const bal = settings.data?.settings.accountBalance;
  const risk = settings.data?.settings.defaultRiskPct;
  const detail = useSetupDetail(assetId, timeframe, bal, risk);
  const candles = useCandles(assetId ?? "BTCUSD", timeframe, 300);
  const tz = useUi((s) => s.timezone);
  const narrative = useNarrativeMutation();
  const [tab, setTab] = useState<"plan" | "alternatives">("plan");
  const s: TradeSetup | undefined = detail.data?.primary;
  return (
    <Drawer open={!!assetId} onClose={onClose} title={s ? `${s.symbol} · ${timeframe} · full analysis` : "Full analysis"} width="max-w-3xl">
      {detail.isLoading || !s ? (
        <SkeletonBlock lines={8} />
      ) : (
        <div className="space-y-5">
          <DataNotice sources={detail.data?.sources} warnings={detail.data?.warnings} />
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={s.status} />
            {s.direction && <Badge tone={s.direction === "LONG" ? "bull" : "bear"}>{s.direction}</Badge>}
            <Badge tone="neutral">{setupTypeLabel(s.setupType)}</Badge>
            <Badge tone="muted">quality {s.qualityScore}/100</Badge>
            <Badge tone="muted">{s.confidence} confidence</Badge>
            <span className="ml-auto text-xs text-ink-3">data as of {fmtDateTime(s.dataAsOf, tz)}</span>
          </div>
          <div className="card overflow-hidden">
            {candles.data ? <PriceChart assetId={s.assetId} timeframe={timeframe} candles={candles.data.candles} levels={detail.data?.levels ?? []} setup={s} overlays={{ ...DEFAULT_OVERLAYS, levels: true }} height={320} showIndicators={false} maxLevels={3} /> : <div className="skeleton h-[320px]" />}
            <div className="px-3 py-2 border-t border-line flex items-center justify-between">
              <span className="text-[11px] text-ink-3">Entry, stop and targets drawn from the plan; dotted lines are structural levels.</span>
              {candles.data && <SourceBadge source={candles.data.source} compact />}
            </div>
          </div>
          {s.status !== "NO TRADE" && (
            <div className="card p-4">
              <RRLadder setup={s} currentPrice={useUi.getState().quotes[s.assetId]?.price} />
            </div>
          )}
          <div className="flex gap-1 border-b border-line">
            {(["plan", "alternatives"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`px-3 h-9 text-sm font-medium ${tab === t ? "text-ink-1 border-b-2 border-accent" : "text-ink-3"}`}>
                {t === "plan" ? "Plan & evidence" : `Alternatives (${detail.data?.alternatives.length ?? 0})`}
              </button>
            ))}
          </div>
          {tab === "plan" ? (
            <div className="space-y-4">
              {s.status !== "NO TRADE" && s.stopLoss !== null && (
                <div className="grid sm:grid-cols-2 gap-3 text-sm">
                  <div className="card p-3 space-y-1">
                    <p className="text-[11px] uppercase tracking-wider text-ink-3">Entry logic</p>
                    <p className="text-ink-2">
                      {s.entry.mode === "immediate" ? "Immediate — price is at the zone." : s.entry.mode === "limit_zone" ? "Limit zone — wait for price to come to it." : "Requires confirmation — do not pre-empt."} Zone {fmtPrice(s.entry.low, s.assetId)}–{fmtPrice(s.entry.high, s.assetId)}.
                    </p>
                    {s.entryConditions.map((c, i) => (
                      <p key={i} className="text-ink-2">
                        • {c}
                      </p>
                    ))}
                  </div>
                  <div className="card p-3 space-y-1">
                    <p className="text-[11px] uppercase tracking-wider text-ink-3">Stop-loss logic</p>
                    <p className="text-ink-2">{s.rationale.find((r) => r.startsWith("Stop")) ?? s.invalidation}</p>
                    <p className="text-ink-2">
                      <span className="text-ink-1 font-medium">Thesis invalid at:</span> {fmtPrice(s.stopLoss, s.assetId)}
                    </p>
                  </div>
                  <div className="card p-3 space-y-1 sm:col-span-2">
                    <p className="text-[11px] uppercase tracking-wider text-ink-3">Take-profit logic</p>
                    <ul className="space-y-1">
                      {s.targets.map((t) => (
                        <li key={t.label} className="flex items-baseline gap-2 text-ink-2">
                          <span className="font-semibold text-bull tabular w-9">{t.label}</span>
                          <span className="tabular text-ink-1 w-24">{fmtPrice(t.price, s.assetId)}</span>
                          <span className="tabular text-ink-3 w-12">{t.rMultiple.toFixed(2)}R</span>
                          <span>{t.basis}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              <div className="card p-3">
                <p className="text-[11px] uppercase tracking-wider text-ink-3 mb-2">Reasoning trail</p>
                <ol className="list-decimal pl-5 space-y-1 text-sm text-ink-2">
                  {s.rationale.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ol>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="card p-3">
                  <EvidenceList title="Supporting evidence" items={s.supporting} tone="bull" />
                </div>
                <div className="card p-3">
                  <EvidenceList title="Opposing evidence" items={s.opposing} tone="bear" />
                </div>
              </div>
              <div className="card p-3">
                <SetupTransparency setup={s} />
              </div>
              <div className="card p-3">
                <p className="text-[11px] uppercase tracking-wider text-ink-3 mb-2">Multi-timeframe read</p>
                <ul className="space-y-1 text-sm text-ink-2">
                  {detail.data?.mtfSummary.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </div>
              <div className="card p-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[11px] uppercase tracking-wider text-ink-3">
                    AI interpretation <Badge tone="warning" size="sm" className="ml-1">interpretation, not data</Badge>
                  </p>
                  <Button size="sm" icon={<Sparkles className="h-3.5 w-3.5" />} loading={narrative.isPending} onClick={() => narrative.mutate({ kind: "setup", assetId: s.assetId, timeframe })}>
                    {narrative.data ? "Regenerate" : "Explain this plan"}
                  </Button>
                </div>
                {narrative.data ? <NarrativeBlock narrative={narrative.data.narrative} /> : <p className="text-xs text-ink-3">Generates a narrative from the computed facts only. Every number is checked against the fact sheet; if no API key is configured the deterministic explanation is shown.</p>}
                {narrative.isError && <p className="text-xs text-bear mt-2">{(narrative.error as Error).message}</p>}
              </div>
              <div className="text-[11px] text-ink-3 space-y-0.5">
                <p className="font-medium text-ink-2">Assumptions</p>
                {s.assumptions.map((a, i) => (
                  <p key={i}>• {a}</p>
                ))}
              </div>
              <Disclaimer />
            </div>
          ) : (
            <div className="space-y-3">
              {detail.data?.alternatives.length ? (
                detail.data.alternatives.map((a) => (
                  <div key={a.id} className="card p-3 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusBadge status={a.status} size="sm" />
                      {a.direction && (
                        <Badge tone={a.direction === "LONG" ? "bull" : "bear"} size="sm">
                          {a.direction}
                        </Badge>
                      )}
                      <Badge tone="neutral" size="sm">
                        {setupTypeLabel(a.setupType)}
                      </Badge>
                      <span className="text-xs text-ink-3 ml-auto">quality {a.qualityScore}</span>
                    </div>
                    {a.stopLoss !== null && (
                      <p className="text-xs text-ink-2 tabular">
                        Entry {fmtPrice(a.entry.low, a.assetId)}–{fmtPrice(a.entry.high, a.assetId)} · SL {fmtPrice(a.stopLoss, a.assetId)} · {a.targets.map((t) => `${t.label} ${fmtPrice(t.price, a.assetId)}`).join(" · ")}
                      </p>
                    )}
                    <p className="text-xs text-ink-2">{a.rationale[0]}</p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-ink-3">No alternative patterns qualified on this timeframe.</p>
              )}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

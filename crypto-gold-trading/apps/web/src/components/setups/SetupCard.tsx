import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { BookmarkPlus, Calculator, ChevronDown, ChevronUp, ClipboardCopy, Eye, FlaskConical, Radar, Star } from "lucide-react";
import { SetupTransparency } from "./Transparency";
import { useMonitorMutations } from "@/lib/queries";
import { resolveAsset, type TradeSetup } from "@terminal/core";
import { Badge, Button, Meter, SourceBadge, Tooltip, type Tone } from "@/components/ui";
import { RRLadder } from "@/components/charts/RRLadder";
import { cls, fmtMoney, fmtPrice, fmtUntil, setupTypeLabel, statusTone } from "@/lib/format";
import { useUi } from "@/lib/store";
import { useSavedSetupMutations, useUpdateWatchlist, useWatchlist } from "@/lib/queries";

export function tradePlanText(s: TradeSetup, currency = "USD"): string {
  const lines = [
    `${s.symbol} ${s.direction ?? ""} — ${s.status} (${setupTypeLabel(s.setupType)}, ${s.timeframe}, context ${s.contextTimeframe})`,
    `Quality ${s.qualityScore}/100 · confidence ${s.confidence} · regime ${s.regime}`,
    `Current price ${fmtPrice(s.currentPrice, s.assetId)} (data as of ${new Date(s.dataAsOf).toISOString()})`,
  ];
  if (s.status !== "NO TRADE" && s.stopLoss !== null) {
    lines.push(`Entry ${s.entry.mode === "immediate" ? "near market" : s.entry.mode === "limit_zone" ? "limit zone" : "on confirmation"}: ${fmtPrice(s.entry.low, s.assetId)} – ${fmtPrice(s.entry.high, s.assetId)}`);
    lines.push(`Stop-loss ${fmtPrice(s.stopLoss, s.assetId)}`);
    for (const t of s.targets) lines.push(`${t.label} ${fmtPrice(t.price, s.assetId)} (${t.rMultiple.toFixed(2)}R) — ${t.basis}`);
    lines.push(`R:R ${s.riskRewardTp1?.toFixed(2)} to TP1, ${s.riskRewardTp2?.toFixed(2)} to TP2`);
    if (s.sizingPreview) lines.push(`Size preview: ${s.sizingPreview.quantity} ${s.sizingPreview.quantityUnit} risking ${fmtMoney(s.sizingPreview.riskAmount, currency)} (${s.sizingPreview.riskPct}% of ${fmtMoney(s.sizingPreview.accountBalance, currency)})`);
    if (s.entryConditions.length) lines.push(`Before entry: ${s.entryConditions.join("; ")}`);
    lines.push(`Invalidation: ${s.invalidation}`);
    lines.push(`Expected hold ${s.expectedHold}; expires ${new Date(s.expiresAt).toISOString()}`);
  }
  lines.push("", "Rationale:", ...s.rationale.map((r) => `- ${r}`));
  if (s.supporting.length) lines.push("", "Supporting:", ...s.supporting.map((e) => `+ ${e.text}`));
  if (s.opposing.length) lines.push("", "Opposing:", ...s.opposing.map((e) => `- ${e.text}`));
  lines.push("", "Research output for human review — not financial advice or an execution instruction.");
  return lines.join("\n");
}

export function StatusBadge({ status, size = "md" }: { status: TradeSetup["status"]; size?: "sm" | "md" }) {
  const tone = statusTone(status);
  return (
    <Badge tone={tone as Tone} size={size} className={cls("font-semibold tracking-wide", status.startsWith("STRONG") && "ring-1 ring-current")}>
      {status}
    </Badge>
  );
}

export function AssetGlyph({ assetId, size = 32 }: { assetId: TradeSetup["assetId"]; size?: number }) {
  const meta = resolveAsset(assetId);
  const gold = meta.assetClass === "gold";
  return (
    <span className={cls("inline-flex items-center justify-center rounded-lg font-bold shrink-0", gold ? "bg-gold-soft text-gold" : "bg-accent-soft text-accent")} style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden>
      {meta.base.slice(0, gold ? 2 : 3)}
    </span>
  );
}

export function SetupCard({ setup, currency = "USD", onOpen, onPaperTrade, compact = false }: { setup: TradeSetup; currency?: string; onOpen: (s: TradeSetup) => void; onPaperTrade: (s: TradeSetup) => void; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const pushToast = useUi((s) => s.pushToast);
  const live = useUi((s) => s.quotes[setup.assetId]?.price);
  const saved = useSavedSetupMutations();
  const mon = useMonitorMutations();
  const wl = useWatchlist();
  const wlm = useUpdateWatchlist();
  const inWatchlist = wl.data?.watchlist.includes(setup.assetId) ?? false;
  const noTrade = setup.status === "NO TRADE";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tradePlanText(setup, currency));
      pushToast({ title: "Trade plan copied", tone: "bull" });
    } catch {
      pushToast({ title: "Clipboard unavailable", body: "Your browser blocked clipboard access.", tone: "warning" });
    }
  };
  const risk = setup.stopLoss !== null ? Math.abs(setup.entry.mid - setup.stopLoss) : null;
  return (
    <article className={cls("card flex flex-col min-w-0", noTrade && "opacity-90")} aria-label={`${setup.symbol} setup`}>
      <header className="flex items-start gap-3 px-4 pt-4 pb-3 border-b border-line">
        <AssetGlyph assetId={setup.assetId} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-ink-1">{setup.symbol}</h3>
            {setup.direction && (
              <Badge tone={setup.direction === "LONG" ? "bull" : "bear"} size="sm">
                {setup.direction}
              </Badge>
            )}
            <Badge tone="neutral" size="sm">
              {setup.timeframe}
            </Badge>
            <Badge tone="muted" size="sm" title={`Context timeframe ${setup.contextTimeframe}`}>
              ctx {setup.contextTimeframe}
            </Badge>
          </div>
          <p className="text-xs text-ink-3 mt-0.5 truncate">{noTrade ? "No qualifying setup" : setupTypeLabel(setup.setupType)} · {setup.regime}</p>
        </div>
        <StatusBadge status={setup.status} />
      </header>

      <div className="p-4 space-y-4">
        {noTrade ? (
          <div className="space-y-2">
            {setup.rationale.map((r, i) => (
              <p key={i} className="text-sm text-ink-2 leading-relaxed">
                {r}
              </p>
            ))}
            <div className="text-xs text-ink-3">
              Current price <span className="tabular text-ink-1">{fmtPrice(live ?? setup.currentPrice, setup.assetId)}</span>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-5 gap-1.5 text-center">
              <Level
                label="Entry"
                value={
                  setup.entry.low === setup.entry.high ? (
                    fmtPrice(setup.entry.mid, setup.assetId)
                  ) : (
                    <>
                      <span className="block">{fmtPrice(setup.entry.low, setup.assetId)}</span>
                      <span className="block">– {fmtPrice(setup.entry.high, setup.assetId)}</span>
                    </>
                  )
                }
                title={`${fmtPrice(setup.entry.low, setup.assetId)} – ${fmtPrice(setup.entry.high, setup.assetId)}`}
                tone="accent"
                sub={setup.entry.mode === "immediate" ? "near market" : setup.entry.mode === "limit_zone" ? "limit zone" : "on confirmation"}
              />
              <Level label="Stop" value={fmtPrice(setup.stopLoss, setup.assetId)} tone="bear" sub="−1.0R" />
              {setup.targets.map((t) => (
                <Level key={t.label} label={t.label} value={fmtPrice(t.price, setup.assetId)} tone="bull" sub={`+${t.rMultiple.toFixed(1)}R`} />
              ))}
            </div>
            <RRLadder setup={setup} currentPrice={live} compact={compact} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 text-xs">
              <Metric label="R:R TP1 / TP2" value={`${setup.riskRewardTp1?.toFixed(2)} / ${setup.riskRewardTp2?.toFixed(2)}`} />
              <Metric label="Position (preview)" value={setup.sizingPreview ? `${setup.sizingPreview.quantity} ${setup.sizingPreview.quantityUnit}` : "—"} hint={setup.sizingPreview ? `${setup.sizingPreview.riskPct}% of ${fmtMoney(setup.sizingPreview.accountBalance, currency, 0)}` : "Set an account balance in Settings"} />
              <Metric label="Potential loss" value={setup.sizingPreview ? fmtMoney(-setup.sizingPreview.riskAmount, currency) : risk ? `${fmtPrice(risk, setup.assetId)} / unit` : "—"} tone="bear" />
              <Metric label="Potential profit (TP2)" value={setup.sizingPreview ? fmtMoney(setup.sizingPreview.potentialProfitTp2, currency) : "—"} tone="bull" />
              <div className="col-span-2 sm:col-span-4">
                <div className="flex items-center justify-between text-[11px] text-ink-3 mb-1">
                  <span>
                    Setup quality <span className="tabular text-ink-1 font-medium">{setup.qualityScore}/100</span> · {setup.confidence} confidence
                  </span>
                  <span>
                    {setup.expectedHold} · expires {fmtUntil(setup.expiresAt)}
                  </span>
                </div>
                <Meter value={setup.qualityScore} tone={setup.qualityScore >= 75 ? "bull" : setup.qualityScore >= 60 ? "accent" : setup.qualityScore >= 45 ? "warning" : "muted"} label="Setup quality" thresholds={[{ at: 45, label: "wait" }, { at: 60, label: "actionable" }, { at: 75, label: "strong" }]} />
              </div>
            </div>
            {setup.entryConditions.length > 0 && (
              <div className="rounded-lg bg-[rgba(250,178,25,0.1)] px-3 py-2 text-xs text-ink-2">
                <span className="font-medium text-warn">Before entry: </span>
                {setup.entryConditions.join(" · ")}
              </div>
            )}
            <p className="text-xs text-ink-2">
              <span className="font-medium text-ink-1">Invalidation: </span>
              {setup.invalidation}
            </p>
          </>
        )}

        {expanded && (
          <div className="space-y-3 pt-2 border-t border-line fade-in">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-ink-3 mb-1">How the engine got here</p>
              <ol className="list-decimal pl-5 space-y-1 text-xs text-ink-2">
                {setup.rationale.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ol>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <EvidenceList title="Supporting" items={setup.supporting} tone="bull" />
              <EvidenceList title="Opposing" items={setup.opposing} tone="bear" />
            </div>
            <SetupTransparency setup={setup} compact />
            <div className="text-[11px] text-ink-3 space-y-0.5">
              {setup.assumptions.map((a, i) => (
                <p key={i}>• {a}</p>
              ))}
            </div>
          </div>
        )}
      </div>

      <footer className="px-4 py-3 border-t border-line flex items-center gap-1.5 flex-wrap">
        <Button size="sm" variant="primary" icon={<Eye className="h-3.5 w-3.5" />} onClick={() => onOpen(setup)}>
          Full analysis
        </Button>
        <Button size="sm" variant="ghost" icon={expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} onClick={() => setExpanded(!expanded)}>
          Breakdown
        </Button>
        {!noTrade && (
          <Button size="sm" variant="ghost" icon={<Calculator className="h-3.5 w-3.5" />} onClick={() => navigate(`/risk?asset=${setup.assetId}&direction=${setup.direction}&entry=${setup.entry.mid}&stop=${setup.stopLoss}&tp=${setup.targets[1]?.price ?? ""}`)}>
            Size
          </Button>
        )}
        {!noTrade && (
          <Button size="sm" variant="ghost" icon={<Radar className="h-3.5 w-3.5" />} loading={mon.track.isPending} onClick={() => mon.track.mutate(setup, { onSuccess: (r) => pushToast({ title: r.created ? "Tracking plan" : "Already tracked", body: `${setup.symbol} ${setup.direction} ${setup.timeframe} — entry, stop and TP1–TP3 will be monitored against live prices. No order is placed.`, tone: "bull" }), onError: (e) => pushToast({ title: "Could not track", body: (e as Error).message, tone: "bear" }) })}>
            Track
          </Button>
        )}
        <span className="ml-auto flex items-center gap-0.5">
          <Tooltip content={inWatchlist ? "In watchlist" : "Add to watchlist"}>
            <button aria-label="Toggle watchlist" className={cls("h-8 w-8 inline-flex items-center justify-center rounded-lg hover:bg-surface-2", inWatchlist ? "text-gold" : "text-ink-3")} onClick={() => wlm.mutate({ watchlist: inWatchlist ? (wl.data?.watchlist ?? []).filter((a) => a !== setup.assetId) : [...(wl.data?.watchlist ?? []), setup.assetId] })}>
              <Star className="h-4 w-4" fill={inWatchlist ? "currentColor" : "none"} />
            </button>
          </Tooltip>
          {!noTrade && (
            <Tooltip content="Save setup">
              <button aria-label="Save setup" className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink-1" onClick={() => saved.save.mutate(setup, { onSuccess: () => pushToast({ title: "Setup saved", body: `${setup.symbol} ${setup.timeframe} plan stored in Settings → Saved setups`, tone: "bull" }) })}>
                <BookmarkPlus className="h-4 w-4" />
              </button>
            </Tooltip>
          )}
          {!noTrade && (
            <Tooltip content="Add to paper-trading journal">
              <button aria-label="Paper trade" className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink-1" onClick={() => onPaperTrade(setup)}>
                <FlaskConical className="h-4 w-4" />
              </button>
            </Tooltip>
          )}
          <Tooltip content="Copy trade plan as text">
            <button aria-label="Copy plan" className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink-1" onClick={copy}>
              <ClipboardCopy className="h-4 w-4" />
            </button>
          </Tooltip>
        </span>
      </footer>
      <div className="px-4 pb-3 -mt-1 flex items-center justify-between gap-2">
        <SourceBadge source={setup.dataSource} compact />
        <span className="text-[10.5px] text-ink-3">Not a signal · research output</span>
      </div>
    </article>
  );
}

function Level({ label, value, tone, sub, title }: { label: string; value: ReactNode; tone: Tone; sub?: string; title?: string }) {
  return (
    <div className={cls("rounded-lg px-1 sm:px-1.5 py-2 min-w-0", tone === "bull" ? "bg-bull-soft" : tone === "bear" ? "bg-bear-soft" : "bg-accent-soft")}>
      <div className="text-[10px] uppercase tracking-wider text-ink-3">{label}</div>
      <div className={cls("text-[11px] sm:text-[13px] font-semibold tabular leading-tight break-words", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-accent")} title={title ?? (typeof value === "string" ? value : undefined)}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-ink-3 truncate">{sub}</div>}
    </div>
  );
}

function Metric({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: Tone }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-ink-3 truncate">{label}</div>
      <div className={cls("text-sm font-semibold tabular truncate", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-ink-1")}>{value}</div>
      {hint && <div className="text-[10.5px] text-ink-3 truncate">{hint}</div>}
    </div>
  );
}

export function EvidenceList({ title, items, tone }: { title: string; items: TradeSetup["supporting"]; tone: "bull" | "bear" }) {
  return (
    <div>
      <p className={cls("text-[11px] uppercase tracking-wider mb-1", tone === "bull" ? "text-bull" : "text-bear")}>
        {title} ({items.length})
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-ink-3">None</p>
      ) : (
        <ul className="space-y-1">
          {items.map((e, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-ink-2">
              <span className={cls("mt-0.5 shrink-0 tabular text-[10px] font-semibold w-7 text-right", tone === "bull" ? "text-bull" : "text-bear")}>
                {e.weight > 0 ? "+" : ""}
                {e.weight}
              </span>
              <span>
                {e.text} <span className="text-ink-3">· {e.category}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

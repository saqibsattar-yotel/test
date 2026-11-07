import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { BookOpen, Download, Plus, Trash2 } from "lucide-react";
import { TIMEFRAMES, type JournalTrade } from "@terminal/core";
import { Badge, Button, Card, Drawer, EmptyState, Field, Input, Modal, PageHeader, Select, SkeletonBlock, Stat, Toggle } from "@/components/ui";
import { TradeForm } from "@/components/journal/TradeForm";
import { useJournal, useJournalMutations, useJournalStats, useSettings } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cls, fmtDateTime, fmtMoney, fmtNum, fmtPrice, fmtR, setupTypeLabel } from "@/lib/format";
import type { JournalFilterParams } from "@/lib/api";

export default function Journal() {
  const [params, setParams] = useSearchParams();
  const settings = useSettings();
  const currency = settings.data?.settings.accountCurrency ?? "USD";
  const tz = useUi((s) => s.timezone);
  const [filter, setFilter] = useState<JournalFilterParams>({ status: "all", test: "0" });
  const [showNew, setShowNew] = useState(params.get("new") === "1");
  const [closing, setClosing] = useState<JournalTrade | null>(null);
  const [viewing, setViewing] = useState<JournalTrade | null>(null);
  const trades = useJournal(filter);
  const stats = useJournalStats(filter);
  const m = useJournalMutations();
  useEffect(() => {
    if (params.get("new") === "1") {
      setShowNew(true);
      setParams({});
    }
  }, [params, setParams]);
  const s = stats.data?.stats;
  const exportCsv = () => {
    const rows = trades.data?.trades ?? [];
    const head = ["id", "asset", "direction", "setup", "timeframe", "opened", "entry", "stop", "takeProfit", "quantity", "unit", "riskPct", "riskAmount", "status", "exit", "closed", "pnl", "R", "tags", "test"];
    const csv = [head.join(","), ...rows.map((t) => [t.id, t.symbol, t.direction, t.setupType, t.timeframe, new Date(t.openedAt).toISOString(), t.entry, t.stop, t.takeProfit ?? "", t.quantity, t.quantityUnit, t.riskPct, t.riskAmount, t.status, t.exitPrice ?? "", t.closedAt ? new Date(t.closedAt).toISOString() : "", t.realizedPnl ?? "", t.rMultiple ?? "", `"${t.tags.join(";")}"`, t.isTestData].join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `journal-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };
  return (
    <div className="space-y-4">
      <PageHeader title="Trade Journal" description="Record what you planned, what happened and what you learned. Statistics below use only real recorded trades unless test data is explicitly included." actions={<><Button variant="ghost" size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={exportCsv} disabled={!trades.data?.trades.length}>Export CSV</Button><Button variant="primary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setShowNew(true)}>Log trade</Button></>} />

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
        <Stat label="Open" value={s?.openTrades ?? "—"} />
        <Stat label="Closed" value={s?.closedTrades ?? "—"} sub={s ? `${s.wins}W · ${s.losses}L · ${s.breakeven}BE` : undefined} />
        <Stat label="Win rate" value={s ? `${s.winRate.toFixed(0)}%` : "—"} />
        <Stat label="Average R" value={s ? fmtR(s.avgR) : "—"} deltaTone={s && s.avgR >= 0 ? "bull" : "bear"} />
        <Stat label="Profit factor" value={s ? (typeof s.profitFactor === "number" && Number.isFinite(s.profitFactor) ? fmtNum(s.profitFactor, 2) : s.grossProfit > 0 && s.grossLoss === 0 ? "∞" : "—") : "—"} />
        <Stat label="Expectancy" value={s ? fmtMoney(s.expectancy, currency) : "—"} sub={s ? `${fmtR(s.expectancyR)} per trade` : undefined} />
        <Stat label="Max drawdown" value={s ? fmtMoney(s.maxDrawdown ? -s.maxDrawdown : 0, currency) : "—"} sub={s?.maxDrawdownPct !== null && s?.maxDrawdownPct !== undefined ? `${s.maxDrawdownPct.toFixed(1)}% of peak` : undefined} />
        <Stat label="Total P&L" value={s ? fmtMoney(s.totalPnl, currency) : "—"} deltaTone={s && s.totalPnl >= 0 ? "bull" : "bear"} />
      </div>

      <Card padded={false}>
        <div className="p-3 grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2 items-end">
          <Field label="Asset"><Select value={filter.asset ?? ""} onChange={(e) => setFilter({ ...filter, asset: e.target.value || undefined })}><option value="">All</option>{Array.from(new Set([...(trades.data?.trades.map((t) => t.assetId) ?? []), ...(filter.asset ? [filter.asset] : [])])).sort().map((a) => <option key={a} value={a}>{a.replace(/USD$/, "/USD")}</option>)}</Select></Field>
          <Field label="Class"><Select value={filter.class ?? ""} onChange={(e) => setFilter({ ...filter, class: e.target.value || undefined })}><option value="">All</option><option value="crypto">Crypto</option><option value="gold">Gold</option></Select></Field>
          <Field label="Timeframe"><Select value={filter.tf ?? ""} onChange={(e) => setFilter({ ...filter, tf: e.target.value || undefined })}><option value="">All</option>{TIMEFRAMES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
          <Field label="Setup"><Select value={filter.setup ?? ""} onChange={(e) => setFilter({ ...filter, setup: e.target.value || undefined })}><option value="">All</option>{["trend_pullback", "breakout", "breakdown", "range_fade", "mean_reversion", "liquidity_sweep_reversal", "other"].map((t) => <option key={t} value={t}>{setupTypeLabel(t)}</option>)}</Select></Field>
          <Field label="Status"><Select value={filter.status ?? "all"} onChange={(e) => setFilter({ ...filter, status: e.target.value })}><option value="all">All</option><option value="open">Open</option><option value="closed">Closed</option></Select></Field>
          <Field label="From"><Input type="date" value={filter.from ?? ""} onChange={(e) => setFilter({ ...filter, from: e.target.value || undefined })} /></Field>
          <Field label="To"><Input type="date" value={filter.to ?? ""} onChange={(e) => setFilter({ ...filter, to: e.target.value || undefined })} /></Field>
          <div className="pb-1"><Toggle checked={filter.test === "1"} onChange={(v) => setFilter({ ...filter, test: v ? "1" : "0" })} label="Include test data" /></div>
        </div>
      </Card>

      <Card padded={false}>
        {trades.isLoading ? <div className="p-4"><SkeletonBlock lines={6} /></div> : !trades.data?.trades.length ? (
          <EmptyState icon={<BookOpen className="h-5 w-5" />} title="No trades recorded" description="Log a trade manually, add a setup to paper trading from the Setups page, or seed labelled test data from Performance." action={<Button size="sm" variant="primary" onClick={() => setShowNew(true)}>Log a trade</Button>} />
        ) : (
          <>
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-ink-3"><th className="px-4 py-2 font-medium">Opened</th><th className="px-2 py-2 font-medium">Asset</th><th className="px-2 py-2 font-medium">Setup</th><th className="px-2 py-2 font-medium text-right">Entry</th><th className="px-2 py-2 font-medium text-right">Stop</th><th className="px-2 py-2 font-medium text-right">TP</th><th className="px-2 py-2 font-medium text-right">Qty</th><th className="px-2 py-2 font-medium text-right">Risk</th><th className="px-2 py-2 font-medium text-right">Exit</th><th className="px-2 py-2 font-medium text-right">P&L</th><th className="px-2 py-2 font-medium text-right">R</th><th className="px-4 py-2 font-medium text-right">Actions</th></tr></thead>
                <tbody>
                  {trades.data.trades.map((t) => (
                    <tr key={t.id} className="border-t border-line hover:bg-surface-2 cursor-pointer" onClick={() => setViewing(t)}>
                      <td className="px-4 py-2 tabular text-ink-2 whitespace-nowrap">{fmtDateTime(t.openedAt, tz)}</td>
                      <td className="px-2 py-2"><span className={cls("font-medium", t.assetClass === "gold" ? "text-gold" : "text-ink-1")}>{t.symbol}</span> <Badge tone={t.direction === "LONG" ? "bull" : "bear"} size="sm">{t.direction}</Badge>{t.isTestData && <Badge tone="warning" size="sm" className="ml-1">TEST</Badge>}{t.source === "paper" && <Badge tone="muted" size="sm" className="ml-1">paper</Badge>}</td>
                      <td className="px-2 py-2 text-ink-2">{setupTypeLabel(t.setupType)} · {t.timeframe}</td>
                      <td className="px-2 py-2 tabular text-right">{fmtPrice(t.entry, t.assetId)}</td>
                      <td className="px-2 py-2 tabular text-right text-bear">{fmtPrice(t.stop, t.assetId)}</td>
                      <td className="px-2 py-2 tabular text-right text-bull">{t.takeProfit ? fmtPrice(t.takeProfit, t.assetId) : "—"}</td>
                      <td className="px-2 py-2 tabular text-right text-ink-2">{t.quantity} {t.quantityUnit}</td>
                      <td className="px-2 py-2 tabular text-right text-ink-2">{fmtMoney(t.riskAmount, currency)} <span className="text-ink-3">({t.riskPct}%)</span></td>
                      <td className="px-2 py-2 tabular text-right">{t.status === "closed" ? fmtPrice(t.exitPrice, t.assetId) : <Badge tone="accent" size="sm">open</Badge>}</td>
                      <td className={cls("px-2 py-2 tabular text-right font-medium", (t.realizedPnl ?? 0) > 0 ? "text-bull" : (t.realizedPnl ?? 0) < 0 ? "text-bear" : "text-ink-2")}>{t.realizedPnl !== null ? fmtMoney(t.realizedPnl, currency) : "—"}</td>
                      <td className={cls("px-2 py-2 tabular text-right", (t.rMultiple ?? 0) > 0 ? "text-bull" : (t.rMultiple ?? 0) < 0 ? "text-bear" : "text-ink-2")}>{t.rMultiple !== null ? fmtR(t.rMultiple) : "—"}</td>
                      <td className="px-4 py-2 text-right" onClick={(e) => e.stopPropagation()}>{t.status === "open" ? <Button size="sm" onClick={() => setClosing(t)}>Close</Button> : <Button size="sm" variant="ghost" onClick={() => setViewing(t)}>Review</Button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="lg:hidden divide-y divide-line">
              {trades.data.trades.map((t) => (
                <li key={t.id} className="p-3 space-y-1" onClick={() => setViewing(t)}>
                  <div className="flex items-center gap-2"><span className={cls("font-medium text-sm", t.assetClass === "gold" ? "text-gold" : "text-ink-1")}>{t.symbol}</span><Badge tone={t.direction === "LONG" ? "bull" : "bear"} size="sm">{t.direction}</Badge><span className="text-xs text-ink-3">{setupTypeLabel(t.setupType)} · {t.timeframe}</span>{t.isTestData && <Badge tone="warning" size="sm">TEST</Badge>}<span className={cls("ml-auto tabular text-sm font-medium", (t.realizedPnl ?? 0) > 0 ? "text-bull" : (t.realizedPnl ?? 0) < 0 ? "text-bear" : "text-ink-2")}>{t.realizedPnl !== null ? fmtMoney(t.realizedPnl, currency) : "open"}</span></div>
                  <div className="text-xs text-ink-2 tabular">E {fmtPrice(t.entry, t.assetId)} · SL {fmtPrice(t.stop, t.assetId)} · TP {t.takeProfit ? fmtPrice(t.takeProfit, t.assetId) : "—"} · {t.quantity} {t.quantityUnit}</div>
                  <div className="flex items-center justify-between text-[11px] text-ink-3"><span>{fmtDateTime(t.openedAt, tz)}</span>{t.status === "open" && <Button size="sm" onClick={(e) => { e.stopPropagation(); setClosing(t); }}>Close</Button>}</div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <TradeForm open={showNew} onClose={() => setShowNew(false)} />
      <CloseModal trade={closing} onClose={() => setClosing(null)} currency={currency} />
      <TradeDrawer trade={viewing} onClose={() => setViewing(null)} currency={currency} onDelete={(id) => m.remove.mutate(id, { onSuccess: () => setViewing(null) })} onUpdate={(id, patch) => m.update.mutate({ id, patch })} />
    </div>
  );
}

function CloseModal({ trade, onClose, currency }: { trade: JournalTrade | null; onClose: () => void; currency: string }) {
  const m = useJournalMutations();
  const quotes = useUi((s) => s.quotes);
  const [exit, setExit] = useState("");
  const [pnl, setPnl] = useState("");
  const [mistakes, setMistakes] = useState("");
  const [lessons, setLessons] = useState("");
  const [mae, setMae] = useState("");
  const [mfe, setMfe] = useState("");
  useEffect(() => {
    if (trade) {
      setExit(quotes[trade.assetId]?.price ? String(quotes[trade.assetId]!.price) : "");
      setPnl("");
      setMistakes("");
      setLessons("");
      setMae("");
      setMfe("");
    }
  }, [trade, quotes]);
  if (!trade) return null;
  const e = parseFloat(exit);
  const contractSize = trade.assetId === "XAUUSD" && trade.quantityUnit === "lots" ? 100 : 1;
  const derived = Number.isFinite(e) ? (trade.direction === "LONG" ? e - trade.entry : trade.entry - e) * trade.quantity * contractSize : null;
  const r = Number.isFinite(e) ? (trade.direction === "LONG" ? e - trade.entry : trade.entry - e) / Math.abs(trade.entry - trade.stop) : null;
  return (
    <Modal open onClose={onClose} title={`Close ${trade.symbol} ${trade.direction}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!Number.isFinite(e)} loading={m.close.isPending} onClick={() => m.close.mutate({ id: trade.id, body: { exitPrice: e, realizedPnl: pnl === "" ? null : parseFloat(pnl), contractSize, mistakes, lessons, mae: mae === "" ? null : parseFloat(mae), mfe: mfe === "" ? null : parseFloat(mfe) } }, { onSuccess: onClose })}>Close trade</Button></>}>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Exit price"><Input type="number" inputMode="decimal" value={exit} onChange={(ev) => setExit(ev.target.value)} /></Field>
        <Field label={`Realised P&L (${currency})`} hint={derived !== null ? `Derived from exit: ${fmtMoney(derived, currency)} (${fmtR(r)}). Override with your broker's figure including fees.` : undefined}><Input type="number" inputMode="decimal" value={pnl} onChange={(ev) => setPnl(ev.target.value)} placeholder={derived !== null ? fmtNum(derived, 2) : ""} /></Field>
        <Field label="Max adverse excursion (R, optional)"><Input type="number" inputMode="decimal" value={mae} onChange={(ev) => setMae(ev.target.value)} placeholder="-0.4" /></Field>
        <Field label="Max favourable excursion (R, optional)"><Input type="number" inputMode="decimal" value={mfe} onChange={(ev) => setMfe(ev.target.value)} placeholder="2.1" /></Field>
        <Field label="Mistakes" className="sm:col-span-2"><textarea value={mistakes} onChange={(ev) => setMistakes(ev.target.value)} rows={2} className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-1" placeholder="Moved the stop, entered early, oversized…" /></Field>
        <Field label="Lessons learned" className="sm:col-span-2"><textarea value={lessons} onChange={(ev) => setLessons(ev.target.value)} rows={2} className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-1" /></Field>
      </div>
    </Modal>
  );
}

function TradeDrawer({ trade, onClose, currency, onDelete, onUpdate }: { trade: JournalTrade | null; onClose: () => void; currency: string; onDelete: (id: string) => void; onUpdate: (id: string, patch: Partial<JournalTrade>) => void }) {
  const tz = useUi((s) => s.timezone);
  const [mistakes, setMistakes] = useState("");
  const [lessons, setLessons] = useState("");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (trade) {
      setMistakes(trade.mistakes);
      setLessons(trade.lessons);
      setConfirm(false);
    }
  }, [trade]);
  if (!trade) return null;
  return (
    <Drawer open onClose={onClose} title={`${trade.symbol} ${trade.direction} · ${setupTypeLabel(trade.setupType)} · ${trade.timeframe}`}>
      <div className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge tone={trade.status === "open" ? "accent" : (trade.realizedPnl ?? 0) >= 0 ? "bull" : "bear"}>{trade.status === "open" ? "OPEN" : `${fmtMoney(trade.realizedPnl, currency)} · ${fmtR(trade.rMultiple)}`}</Badge>
          {trade.isTestData && <Badge tone="warning">TEST DATA</Badge>}
          <Badge tone="muted">{trade.source}</Badge>
          {trade.tags.map((t) => <Badge key={t} tone="neutral" size="sm">{t}</Badge>)}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          {[["Entry", fmtPrice(trade.entry, trade.assetId)], ["Stop", fmtPrice(trade.stop, trade.assetId)], ["Take-profit", trade.takeProfit ? fmtPrice(trade.takeProfit, trade.assetId) : "—"], ["Quantity", `${trade.quantity} ${trade.quantityUnit}`], ["Risk", `${fmtMoney(trade.riskAmount, currency)} (${trade.riskPct}%)`], ["Opened", fmtDateTime(trade.openedAt, tz)], ["Exit", trade.exitPrice ? fmtPrice(trade.exitPrice, trade.assetId) : "—"], ["Closed", trade.closedAt ? fmtDateTime(trade.closedAt, tz) : "—"], ["MAE / MFE", `${trade.mae ?? "—"} / ${trade.mfe ?? "—"}`]].map(([k, v]) => (
            <div key={k} className="card p-2.5"><div className="text-ink-3">{k}</div><div className="tabular text-ink-1 font-medium">{v}</div></div>
          ))}
        </div>
        <div><p className="text-[11px] uppercase tracking-wider text-ink-3 mb-1">Entry reasoning</p><p className="text-sm text-ink-2 whitespace-pre-wrap">{trade.entryReasoning || "—"}</p></div>
        {trade.screenshots.length > 0 && <div><p className="text-[11px] uppercase tracking-wider text-ink-3 mb-1">Screenshots</p><div className="grid grid-cols-2 gap-2">{trade.screenshots.map((s, i) => <a key={i} href={s} target="_blank" rel="noreferrer"><img src={s} alt={`Screenshot ${i + 1}`} className="rounded-lg border border-line w-full" /></a>)}</div></div>}
        <Field label="Mistakes"><textarea value={mistakes} onChange={(e) => setMistakes(e.target.value)} rows={3} className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-1" /></Field>
        <Field label="Lessons learned"><textarea value={lessons} onChange={(e) => setLessons(e.target.value)} rows={3} className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-1" /></Field>
        <div className="flex items-center justify-between">
          <Button variant="primary" size="sm" onClick={() => onUpdate(trade.id, { mistakes, lessons })}>Save notes</Button>
          {confirm ? <div className="flex items-center gap-2 text-xs text-ink-2">Delete permanently? <Button size="sm" variant="danger" onClick={() => onDelete(trade.id)}>Yes, delete</Button><Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>No</Button></div> : <Button variant="ghost" size="sm" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirm(true)}>Delete</Button>}
        </div>
      </div>
    </Drawer>
  );
}

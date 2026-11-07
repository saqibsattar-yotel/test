import { useState } from "react";
import { BarChart3, FlaskConical } from "lucide-react";
import { Badge, Button, Card, Disclaimer, EmptyState, PageHeader, Segmented, SkeletonBlock, Stat, Toggle } from "@/components/ui";
import { EquityCurve, HBarList, MonthlyBars } from "@/components/charts/Performance";
import { useJournalMutations, useJournalStats, useSettings } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cls, fmtMoney, fmtNum, fmtR, setupTypeLabel } from "@/lib/format";

export default function Performance() {
  const settings = useSettings();
  const currency = settings.data?.settings.accountCurrency ?? "USD";
  const [cls_, setCls] = useState<"" | "crypto" | "gold">("");
  const [range, setRange] = useState<"all" | "90" | "30">("all");
  const [test, setTest] = useState(false);
  const pushToast = useUi((s) => s.pushToast);
  const from = range === "all" ? undefined : new Date(Date.now() - parseInt(range, 10) * 86_400_000).toISOString().slice(0, 10);
  const stats = useJournalStats({ class: cls_ || undefined, from, test: test ? "1" : "0" });
  const m = useJournalMutations();
  const s = stats.data?.stats;
  const pf = (v: number | null | undefined, positive = (s?.grossProfit ?? 0) > 0 && (s?.grossLoss ?? 0) === 0) => (typeof v === "number" && Number.isFinite(v) ? fmtNum(v, 2) : positive ? "∞" : "—");
  return (
    <div className="space-y-4">
      <PageHeader title="Performance Analytics" description="Computed from recorded trades only. Test data is excluded unless you include it explicitly, and is always labelled." actions={<><Segmented size="sm" options={[{ value: "" as const, label: "All" }, { value: "crypto" as const, label: "Crypto" }, { value: "gold" as const, label: "Gold" }]} value={cls_} onChange={setCls} /><Segmented size="sm" options={[{ value: "all" as const, label: "All time" }, { value: "90" as const, label: "90d" }, { value: "30" as const, label: "30d" }]} value={range} onChange={setRange} /><Toggle checked={test} onChange={setTest} label="Include test data" /></>} />
      {test && s?.includesTestData && <div className="rounded-lg bg-[rgba(250,178,25,0.12)] text-warn text-xs px-3 py-2 flex items-center gap-2"><FlaskConical className="h-3.5 w-3.5" /> Statistics include explicitly labelled TEST trades. They are illustrative and do not reflect real performance.</div>}
      {stats.isLoading ? <SkeletonBlock lines={6} /> : !s || s.closedTrades === 0 ? (
        <Card>
          <EmptyState icon={<BarChart3 className="h-5 w-5" />} title="No closed trades to analyse" description="Close trades in the journal to build the equity curve, or seed clearly labelled test data to explore the dashboard." action={<div className="flex gap-2"><Button size="sm" variant="secondary" loading={m.seed.isPending} onClick={() => m.seed.mutate(undefined, { onSuccess: (d) => { setTest(true); pushToast({ title: `${d.seeded} test trades seeded`, body: "Labelled TEST and excluded from real statistics", tone: "warning" }); } })}>Seed test data</Button></div>} />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
            <Stat label="Total trades" value={s.totalTrades} sub={`${s.closedTrades} closed · ${s.openTrades} open`} />
            <Stat label="Win rate" value={`${s.winRate.toFixed(1)}%`} sub={`${s.wins}W / ${s.losses}L / ${s.breakeven}BE`} />
            <Stat label="Average win" value={fmtMoney(s.avgWin, currency)} sub={`${fmtR(s.avgWinR)}`} deltaTone="bull" />
            <Stat label="Average loss" value={fmtMoney(-s.avgLoss, currency)} sub={`${fmtR(s.avgLossR)}`} deltaTone="bear" />
            <Stat label="R:R achieved" value={Number.isFinite(s.achievedRR) ? fmtNum(s.achievedRR, 2) : "∞"} hint="Average win ÷ average loss" />
            <Stat label="Profit factor" value={pf(s.profitFactor)} hint="Gross profit ÷ gross loss" />
            <Stat label="Expectancy" value={fmtMoney(s.expectancy, currency)} sub={`${fmtR(s.expectancyR)} per trade`} deltaTone={s.expectancy >= 0 ? "bull" : "bear"} />
            <Stat label="Max drawdown" value={fmtMoney(-s.maxDrawdown, currency)} sub={s.maxDrawdownPct !== null ? `${s.maxDrawdownPct.toFixed(1)}% from peak` : undefined} deltaTone="bear" />
            <Stat label="Largest win" value={fmtMoney(s.largestWin, currency)} deltaTone="bull" />
            <Stat label="Largest loss" value={fmtMoney(s.largestLoss, currency)} deltaTone="bear" />
            <Stat label="Gross profit" value={fmtMoney(s.grossProfit, currency)} />
            <Stat label="Gross loss" value={fmtMoney(-s.grossLoss, currency)} />
          </div>
          <div className="grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
            <Card title="Equity curve" subtitle={`Cumulative realised P&L on top of the ${fmtMoney(settings.data?.settings.accountBalance ?? 0, currency, 0)} account balance`}>
              <EquityCurve points={s.equityCurve} currency={currency} />
            </Card>
            <Card title="Monthly performance" subtitle="Realised P&L by month closed (green up, red down)">
              <MonthlyBars monthly={s.monthly} currency={currency} />
            </Card>
          </div>
          <div className="grid lg:grid-cols-3 gap-4">
            <Card title="By setup type" subtitle="Total P&L · hover rows for details" padded={false}>
              <table className="w-full text-xs"><thead><tr className="text-left text-ink-3"><th className="px-4 py-2 font-medium">Setup</th><th className="px-2 py-2 font-medium text-right">Trades</th><th className="px-2 py-2 font-medium text-right">Win</th><th className="px-2 py-2 font-medium text-right">Avg R</th><th className="px-4 py-2 font-medium text-right">P&L</th></tr></thead>
                <tbody>{s.bySetup.map((r) => <tr key={r.key} className="border-t border-line"><td className="px-4 py-1.5 text-ink-1">{setupTypeLabel(r.key)}</td><td className="px-2 py-1.5 tabular text-right text-ink-2">{r.trades}</td><td className="px-2 py-1.5 tabular text-right text-ink-2">{r.winRate.toFixed(0)}%</td><td className={cls("px-2 py-1.5 tabular text-right", r.avgR >= 0 ? "text-bull" : "text-bear")}>{fmtR(r.avgR)}</td><td className={cls("px-4 py-1.5 tabular text-right font-medium", r.totalPnl >= 0 ? "text-bull" : "text-bear")}>{fmtMoney(r.totalPnl, currency)}</td></tr>)}</tbody></table>
            </Card>
            <Card title="Best & worst setups" subtitle="Requires ≥ 3 closed trades per setup">
              {s.bestSetups.length ? (
                <div className="space-y-4">
                  <div><p className="text-[11px] uppercase tracking-wider text-bull mb-1">Best</p><HBarList rows={s.bestSetups.map((b) => ({ key: b.key, label: setupTypeLabel(b.key), value: b.totalPnl }))} valueFormatter={(v) => fmtMoney(v, currency, 0)} /></div>
                  <div><p className="text-[11px] uppercase tracking-wider text-bear mb-1">Worst</p><HBarList rows={s.worstSetups.map((b) => ({ key: b.key, label: setupTypeLabel(b.key), value: b.totalPnl }))} valueFormatter={(v) => fmtMoney(v, currency, 0)} /></div>
                </div>
              ) : <p className="text-xs text-ink-3">Not enough trades per setup yet (need 3+).</p>}
            </Card>
            <Card title="Crypto vs gold">
              <div className="grid grid-cols-2 gap-3">
                {(["crypto", "gold"] as const).map((k) => {
                  const c = s.byClass[k];
                  return (
                    <div key={k} className={cls("card p-3", k === "gold" && "bg-gold-soft")}>
                      <div className={cls("text-xs font-semibold uppercase tracking-wider", k === "gold" ? "text-gold" : "text-accent")}>{k}</div>
                      {c ? (
                        <div className="mt-1 space-y-0.5 text-xs text-ink-2">
                          <div className="flex justify-between"><span>Trades</span><span className="tabular text-ink-1">{c.trades}</span></div>
                          <div className="flex justify-between"><span>Win rate</span><span className="tabular text-ink-1">{c.winRate.toFixed(0)}%</span></div>
                          <div className="flex justify-between"><span>Avg R</span><span className={cls("tabular", c.avgR >= 0 ? "text-bull" : "text-bear")}>{fmtR(c.avgR)}</span></div>
                          <div className="flex justify-between"><span>Profit factor</span><span className="tabular text-ink-1">{pf(c.profitFactor, c.totalPnl > 0 && c.winRate === 100)}</span></div>
                          <div className="flex justify-between"><span>P&L</span><span className={cls("tabular font-medium", c.totalPnl >= 0 ? "text-bull" : "text-bear")}>{fmtMoney(c.totalPnl, currency)}</span></div>
                        </div>
                      ) : <p className="text-xs text-ink-3 mt-1">No closed trades</p>}
                    </div>
                  );
                })}
              </div>
              <div className="mt-3"><p className="text-[11px] uppercase tracking-wider text-ink-3 mb-1">By asset</p><HBarList rows={s.byAsset.map((b) => ({ key: b.key, value: b.totalPnl }))} valueFormatter={(v) => fmtMoney(v, currency, 0)} /></div>
            </Card>
          </div>
        </>
      )}
      <div className="flex items-center gap-2 flex-wrap text-xs text-ink-3">
        <Badge tone="warning" size="sm">Test data tools</Badge>
        <Button size="sm" variant="ghost" loading={m.seed.isPending} onClick={() => m.seed.mutate(undefined, { onSuccess: (d) => { setTest(true); pushToast({ title: `${d.seeded} test trades seeded`, tone: "warning" }); } })}>Seed labelled test trades</Button>
        <Button size="sm" variant="ghost" loading={m.clearTest.isPending} onClick={() => m.clearTest.mutate(undefined, { onSuccess: (d) => pushToast({ title: `${d.removed} test trades removed`, tone: "neutral" }) })}>Remove all test data</Button>
        <span>Test trades never count toward real statistics unless you toggle them on.</span>
      </div>
      <Disclaimer />
    </div>
  );
}

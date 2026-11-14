import { useState } from "react";
import { FlaskConical, Play } from "lucide-react";
import { TIMEFRAMES, type Timeframe } from "@terminal/core";
import { Badge, Button, Card, DataNotice, Disclaimer, EmptyState, Field, Input, PageHeader, Segmented, Select, SourceBadge, Stat, Toggle } from "@/components/ui";
import { AssetPicker } from "@/components/ui/AssetPicker";
import { EquityCurve } from "@/components/charts/Performance";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { useBacktestMutation, useSettings } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cls, fmtDate, fmtMoney, fmtNum, fmtPct, fmtPrice, fmtR, setupTypeLabel } from "@/lib/format";
import { useAssetLabel } from "@/lib/assets";
import type { BacktestRequest } from "@/lib/api";

export default function Backtest() {
  const settings = useSettings();
  const ui = useUi();
  const L = useAssetLabel();
  const [req, setReq] = useState<BacktestRequest>({ assetId: ui.selectedAsset, timeframe: "4h", bars: 1500, feesBps: 5, slippageBps: 3, riskPct: 1, startingEquity: 10_000, exitModel: "ladder", maxPendingBars: 6, minQuality: 60, splitPct: 0.7, stepBars: 1, allowLongs: true, allowShorts: true });
  const [view, setView] = useState<"all" | "inSample" | "outOfSample">("all");
  const run = useBacktestMutation();
  const set = <K extends keyof BacktestRequest>(k: K, v: BacktestRequest[K]) => setReq({ ...req, [k]: v });
  const r = run.data?.result;
  const stats = r ? r[view] : null;
  const currency = settings.data?.settings.accountCurrency ?? "USD";
  const pf = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? fmtNum(v, 2) : v === null || v === undefined ? "∞" : "—");
  return (
    <div className="space-y-4">
      <PageHeader title="Backtesting" description="Walk-forward test of the setup engine on historical candles: closed-bar signals only, fills from the next bar, conservative intra-bar resolution, fees and slippage, in-sample / out-of-sample split. Past results never promise future ones." />
      <Card title="Strategy & costs">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Field label="Asset">
            <AssetPicker value={req.assetId} onSelect={(id) => set("assetId", id)} />
          </Field>
          <Field label="Timeframe">
            <Select value={req.timeframe} onChange={(e) => set("timeframe", e.target.value as Timeframe)}>
              {TIMEFRAMES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
          <Field label="Bars of history" hint="Up to 3000 (paged from the provider). 4h × 1500 ≈ 250 days.">
            <Input type="number" value={req.bars} onChange={(e) => set("bars", parseInt(e.target.value, 10) || 1000)} />
          </Field>
          <Field label="Exit model">
            <Select value={req.exitModel} onChange={(e) => set("exitModel", e.target.value as BacktestRequest["exitModel"])}>
              <option value="ladder">Ladder: ⅓ at TP1 (stop → breakeven), ⅓ at TP2, rest at TP3</option>
              <option value="tp1">Full exit at TP1</option>
              <option value="tp2">Full exit at TP2</option>
              <option value="tp3">Full exit at TP3</option>
            </Select>
          </Field>
          <Field label="Fees (bps per side)" hint="Binance spot taker ≈ 10 bps, maker ≈ 10; VIP tiers lower. Gold or silver CFD: use spread/2 in bps.">
            <Input type="number" value={req.feesBps} onChange={(e) => set("feesBps", parseFloat(e.target.value) || 0)} />
          </Field>
          <Field label="Slippage (bps on market fills)">
            <Input type="number" value={req.slippageBps} onChange={(e) => set("slippageBps", parseFloat(e.target.value) || 0)} />
          </Field>
          <Field label="Risk per trade (%)">
            <Input type="number" step="0.25" value={req.riskPct} onChange={(e) => set("riskPct", parseFloat(e.target.value) || 1)} />
          </Field>
          <Field label="Starting equity">
            <Input type="number" value={req.startingEquity} onChange={(e) => set("startingEquity", parseFloat(e.target.value) || 10000)} />
          </Field>
          <Field label="Minimum setup quality">
            <Input type="number" value={req.minQuality} onChange={(e) => set("minQuality", parseFloat(e.target.value) || 60)} />
          </Field>
          <Field label="Pending signal expiry (bars)">
            <Input type="number" value={req.maxPendingBars} onChange={(e) => set("maxPendingBars", parseInt(e.target.value, 10) || 6)} />
          </Field>
          <Field label="In-sample share" hint="First part of the period is in-sample; the remainder is out-of-sample.">
            <Select value={String(req.splitPct)} onChange={(e) => set("splitPct", parseFloat(e.target.value))}>
              <option value="0.6">60 / 40</option>
              <option value="0.7">70 / 30</option>
              <option value="0.8">80 / 20</option>
            </Select>
          </Field>
          <Field label="Signal step (bars)" hint="Evaluate a new signal every N bars (1 = every bar; higher is faster).">
            <Input type="number" value={req.stepBars} onChange={(e) => set("stepBars", parseInt(e.target.value, 10) || 1)} />
          </Field>
          <div className="flex items-end gap-4 sm:col-span-2">
            <Toggle checked={req.allowLongs} onChange={(v) => set("allowLongs", v)} label="Longs" />
            <Toggle checked={req.allowShorts} onChange={(v) => set("allowShorts", v)} label="Shorts" />
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" icon={<Play className="h-4 w-4" />} loading={run.isPending} onClick={() => run.mutate(req)}>
            Run backtest
          </Button>
          {run.isError && <span className="text-xs text-bear">{(run.error as Error).message}</span>}
          {run.isPending && <span className="text-xs text-ink-3">Walking forward bar by bar — this can take a few seconds.</span>}
        </div>
      </Card>

      {!r && !run.isPending && (
        <Card>
          <EmptyState icon={<FlaskConical className="h-5 w-5" />} title="Configure and run a backtest" description="The same deterministic setup engine that powers the AI Trade Setups page is applied bar by bar to historical data. Results are reported separately for the in-sample and out-of-sample periods." />
        </Card>
      )}

      {r && stats && (
        <>
          <DataNotice sources={[run.data!.source]} warnings={[...run.data!.warnings, ...r.warnings]} />
          <div className="flex items-center gap-3 flex-wrap">
            <Segmented options={[{ value: "all" as const, label: `All (${r.all.trades})` }, { value: "inSample" as const, label: `In-sample (${r.inSample.trades})` }, { value: "outOfSample" as const, label: `Out-of-sample (${r.outOfSample.trades})` }]} value={view} onChange={setView} />
            <span className="text-xs text-ink-3">
              {L(r.config.assetId).symbol} · {r.config.timeframe} · {r.bars} bars · {fmtDate(r.periodFrom, ui.timezone)} → {fmtDate(r.periodTo, ui.timezone)} · split at {fmtDate(r.inSampleUntil, ui.timezone)} · {r.signals} signals · {r.durationMs} ms
            </span>
            <SourceBadge source={run.data!.source} compact />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
            <Stat label="Trades" value={stats.trades} sub={`${stats.wins}W / ${stats.losses}L`} />
            <Stat label="Win rate" value={`${stats.winRate.toFixed(1)}%`} />
            <Stat label="Expectancy" value={fmtMoney(stats.expectancy, currency)} sub={`${fmtR(stats.expectancyR)} per trade`} deltaTone={stats.expectancyR >= 0 ? "bull" : "bear"} />
            <Stat label="Profit factor" value={pf(stats.profitFactor)} />
            <Stat label="Max drawdown" value={fmtMoney(-stats.maxDrawdown, currency)} sub={`${stats.maxDrawdownPct.toFixed(1)}%`} />
            <Stat label="Return" value={fmtPct(stats.returnPct, 1)} sub={fmtMoney(stats.totalPnl, currency)} deltaTone={stats.totalPnl >= 0 ? "bull" : "bear"} />
            <Stat label="Average R" value={fmtR(stats.avgR)} sub={`best ${fmtR(stats.bestR)} · worst ${fmtR(stats.worstR)}`} />
            <Stat label="Avg win / loss" value={`${fmtMoney(stats.avgWin, currency, 0)} / ${fmtMoney(-stats.avgLoss, currency, 0)}`} />
            <Stat label="Avg bars held" value={fmtNum(stats.avgBarsHeld, 1)} />
          </div>
          <div className="grid xl:grid-cols-2 gap-4">
            <Card title="Equity curve" subtitle={`${view === "all" ? "Whole period" : view === "inSample" ? "In-sample" : "Out-of-sample"} · compounding at ${r.config.riskPct}% risk`}>
              <EquityCurve points={stats.equityCurve} currency={currency} />
            </Card>
            <Card title="R-multiple distribution" subtitle="Outcome per trade in units of initial risk">
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.rDistribution} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="var(--grid)" vertical={false} />
                    <XAxis dataKey="bucket" stroke="var(--axis)" tick={{ fill: "var(--ink-3)", fontSize: 11 }} />
                    <YAxis allowDecimals={false} stroke="var(--axis)" tick={{ fill: "var(--ink-3)", fontSize: 11 }} width={32} />
                    <RTooltip contentStyle={{ background: "var(--surface-3)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12, color: "var(--ink-1)" }} cursor={{ fill: "var(--surface-3)", opacity: 0.4 }} />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={32}>
                      {stats.rDistribution.map((b) => (
                        <Cell key={b.bucket} fill={b.bucket.startsWith("≤") || b.bucket.startsWith("-") ? "var(--bear)" : "var(--bull)"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>
          <div className="grid xl:grid-cols-3 gap-4">
            <Card title="In-sample vs out-of-sample" subtitle="Compare before trusting">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-ink-3 text-left">
                    <th className="py-1 font-medium">Metric</th>
                    <th className="py-1 font-medium text-right">In</th>
                    <th className="py-1 font-medium text-right">Out</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Trades", r.inSample.trades, r.outOfSample.trades],
                    ["Win rate", `${r.inSample.winRate.toFixed(0)}%`, `${r.outOfSample.winRate.toFixed(0)}%`],
                    ["Expectancy (R)", fmtR(r.inSample.expectancyR), fmtR(r.outOfSample.expectancyR)],
                    ["Profit factor", pf(r.inSample.profitFactor), pf(r.outOfSample.profitFactor)],
                    ["Max DD", `${r.inSample.maxDrawdownPct.toFixed(1)}%`, `${r.outOfSample.maxDrawdownPct.toFixed(1)}%`],
                    ["Return", fmtPct(r.inSample.returnPct, 1), fmtPct(r.outOfSample.returnPct, 1)],
                  ].map(([k, a, b]) => (
                    <tr key={String(k)} className="border-t border-line">
                      <td className="py-1 text-ink-2">{k}</td>
                      <td className="py-1 text-right tabular text-ink-1">{a}</td>
                      <td className="py-1 text-right tabular text-ink-1">{b}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="By setup type & direction">
              <table className="w-full text-xs">
                <tbody>
                  {[...stats.bySetup.map((x) => ({ ...x, key: setupTypeLabel(x.key) })), ...stats.byDirection].map((x) => (
                    <tr key={x.key} className="border-t border-line first:border-0">
                      <td className="py-1 text-ink-1">{x.key}</td>
                      <td className="py-1 text-right tabular text-ink-2">{x.trades}</td>
                      <td className="py-1 text-right tabular text-ink-2">{x.winRate.toFixed(0)}%</td>
                      <td className={cls("py-1 text-right tabular", x.avgR >= 0 ? "text-bull" : "text-bear")}>{fmtR(x.avgR)}</td>
                      <td className={cls("py-1 text-right tabular font-medium", x.totalPnl >= 0 ? "text-bull" : "text-bear")}>{fmtMoney(x.totalPnl, currency, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Assumptions & bias controls">
              <ul className="text-[11px] text-ink-2 space-y-1">
                {r.assumptions.map((a, i) => (
                  <li key={i}>• {a}</li>
                ))}
              </ul>
            </Card>
          </div>
          <Card title={`Trades (${r.trades.length})`} padded={false}>
            <div className="overflow-x-auto max-h-[480px]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface-1">
                  <tr className="text-ink-3 text-left">
                    <th className="px-4 py-2 font-medium">#</th>
                    <th className="px-2 py-2 font-medium">Signal</th>
                    <th className="px-2 py-2 font-medium">Dir · setup</th>
                    <th className="px-2 py-2 font-medium text-right">Entry</th>
                    <th className="px-2 py-2 font-medium text-right">Stop</th>
                    <th className="px-2 py-2 font-medium text-right">Exit</th>
                    <th className="px-2 py-2 font-medium">Reason</th>
                    <th className="px-2 py-2 font-medium text-right">R</th>
                    <th className="px-2 py-2 font-medium text-right">P&L</th>
                    <th className="px-4 py-2 font-medium">Sample</th>
                  </tr>
                </thead>
                <tbody>
                  {r.trades
                    .slice()
                    .reverse()
                    .map((t) => (
                      <tr key={t.id} className="border-t border-line">
                        <td className="px-4 py-1.5 text-ink-3">{t.id}</td>
                        <td className="px-2 py-1.5 tabular text-ink-2 whitespace-nowrap">{fmtDate(t.signalTime, ui.timezone)}</td>
                        <td className="px-2 py-1.5">
                          <Badge tone={t.direction === "LONG" ? "bull" : "bear"} size="sm">
                            {t.direction}
                          </Badge>{" "}
                          <span className="text-ink-2">{setupTypeLabel(t.setupType)}</span> <span className="text-ink-3">q{t.quality}</span>
                        </td>
                        <td className="px-2 py-1.5 tabular text-right">{fmtPrice(t.entryPrice, r.config.assetId)}</td>
                        <td className="px-2 py-1.5 tabular text-right text-bear">{fmtPrice(t.stop, r.config.assetId)}</td>
                        <td className="px-2 py-1.5 tabular text-right">{fmtPrice(t.exitPrice, r.config.assetId)}</td>
                        <td className="px-2 py-1.5 text-ink-2">{t.exitReason}</td>
                        <td className={cls("px-2 py-1.5 tabular text-right font-medium", t.rMultiple >= 0 ? "text-bull" : "text-bear")}>{fmtR(t.rMultiple)}</td>
                        <td className={cls("px-2 py-1.5 tabular text-right", t.pnl >= 0 ? "text-bull" : "text-bear")}>{fmtMoney(t.pnl, currency)}</td>
                        <td className="px-4 py-1.5 text-ink-3">{t.sample === "in" ? "in" : "out"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
      <Disclaimer />
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { assetBase, type AssetId, type InstrumentSpec } from "@terminal/core";
import { Badge, Button, Card, Checkmark, Disclaimer, Field, Input, Meter, PageHeader, Segmented, Select, Toggle, Tooltip } from "@/components/ui";
import { AssetPicker } from "@/components/ui/AssetPicker";
import { useCircuitBreaker, useGateMutation, useInstruments, useSettings, useSizeMutation } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cls, fmtDateTime, fmtMoney, fmtNum, fmtPct, fmtPrice } from "@/lib/format";

export default function Risk() {
  const [params] = useSearchParams();
  const settings = useSettings();
  const instruments = useInstruments();
  const size = useSizeMutation();
  const gate = useGateMutation();
  const cb = useCircuitBreaker();
  const quotes = useUi((s) => s.quotes);
  const tz = useUi((s) => s.timezone);
  const [asset, setAsset] = useState<AssetId>((params.get("asset") as AssetId) || "BTCUSD");
  const [direction, setDirection] = useState<"LONG" | "SHORT">((params.get("direction") as "LONG" | "SHORT") || "LONG");
  const [balance, setBalance] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [riskPct, setRiskPct] = useState("1");
  const [entry, setEntry] = useState(params.get("entry") ?? "");
  const [stop, setStop] = useState(params.get("stop") ?? "");
  const [tp, setTp] = useState(params.get("tp") ?? "");
  const [leverage, setLeverage] = useState("");
  const [fx, setFx] = useState("1");
  const [specId, setSpecId] = useState<string>("");
  const [custom, setCustom] = useState(false);
  const [cSize, setCSize] = useState("100");
  const [cTick, setCTick] = useState("0.01");
  const [cStep, setCStep] = useState("0.01");
  const [cMin, setCMin] = useState("0.01");
  const [cKind, setCKind] = useState<InstrumentSpec["kind"]>("gold_cfd");
  const [plan, setPlan] = useState({ written: true, stopDefined: true, sizeOk: true });
  useEffect(() => {
    const s = settings.data?.settings;
    if (s) {
      setBalance((b) => b || String(s.accountBalance));
      setCurrency(s.accountCurrency);
      setRiskPct(String(s.defaultRiskPct));
    }
  }, [settings.data]);
  const specs = instruments.data?.instruments ?? [];
  const relevant = useMemo(() => specs.filter((s) => (asset === "XAUUSD" ? s.kind.startsWith("gold") : s.kind.startsWith("crypto"))), [specs, asset]);
  useEffect(() => {
    if (!relevant.length) return;
    const preferred = relevant.find((s) => s.id.includes(asset.replace("USD", "USDT"))) ?? relevant[0];
    setSpecId((cur) => (relevant.some((s) => s.id === cur) ? cur : preferred.id));
  }, [relevant, asset]);
  const spec = specs.find((s) => s.id === specId);
  const q = quotes[asset];
  const run = () => {
    size.mutate({
      accountBalance: parseFloat(balance),
      accountCurrency: currency,
      riskPct: parseFloat(riskPct),
      direction,
      entry: parseFloat(entry),
      stop: parseFloat(stop),
      takeProfit: tp === "" ? null : parseFloat(tp),
      leverage: leverage === "" ? null : parseFloat(leverage),
      specId: custom ? undefined : specId,
      customSpec: custom ? { kind: cKind, contractSize: parseFloat(cSize), tickSize: parseFloat(cTick), qtyStep: parseFloat(cStep), minQty: parseFloat(cMin), label: "Custom instrument", baseUnit: asset === "XAUUSD" ? "oz" : assetBase(asset), quantityUnit: cKind.includes("futures") || cKind === "crypto_futures_cme" ? "contracts" : cKind === "gold_cfd" ? "lots" : assetBase(asset), hardTickGrid: cKind.includes("futures") } : undefined,
      fxQuoteToAccount: currency === "USD" || currency === "USDT" ? 1 : parseFloat(fx) || 1,
    });
  };
  const r = size.data?.result;
  const canRun = [balance, riskPct, entry, stop].every((v) => v !== "" && Number.isFinite(parseFloat(v)));
  const runGate = () => gate.mutate({ entryInWrittenPlan: plan.written, stopPredefined: plan.stopDefined, sizeWithinPlan: plan.sizeOk, plannedRiskAmount: r ? r.riskBudgetAccount : null, actualRiskAmount: r ? r.potentialLossAccount : null, assetId: asset, direction });
  return (
    <div className="space-y-4">
      <PageHeader title="Risk Calculator" description="Deterministic position sizing with real instrument specifications: spot crypto, USDT perpetuals, XAU/USD CFD lots, COMEX GC/MGC and CME BTC/MBT futures. Margin is an estimate; exchange margin is never computed for futures." />
      <div className="grid xl:grid-cols-[minmax(0,1fr)_420px] gap-4">
        <div className="space-y-4">
          <Card title="Trade parameters">
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <Field label="Account balance"><Input type="number" inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} /></Field>
              <Field label="Account currency">
                <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>{["USD", "USDT", "EUR", "GBP", "CHF", "JPY", "AUD", "CAD"].map((c) => <option key={c}>{c}</option>)}</Select>
              </Field>
              <Field label="Risk per trade (%)" hint="Risk budget = balance × risk%. Above 2% triggers a warning."><Input type="number" inputMode="decimal" step="0.25" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} /></Field>
              {currency !== "USD" && currency !== "USDT" && <Field label={`USD → ${currency} rate`} hint="Instruments are USD-quoted. Enter how many units of your account currency one USD is worth."><Input type="number" inputMode="decimal" step="0.0001" value={fx} onChange={(e) => setFx(e.target.value)} /></Field>}
              <Field label="Asset">
                <AssetPicker value={asset} onSelect={(id) => setAsset(id as AssetId)} />
              </Field>
              <Field label="Direction"><Segmented options={[{ value: "LONG" as const, label: "Long" }, { value: "SHORT" as const, label: "Short" }]} value={direction} onChange={setDirection} className="w-full" /></Field>
              <Field label="Entry price" hint={q ? `Live ${fmtPrice(q.price, asset)}` : undefined}>
                <div className="flex gap-1.5"><Input type="number" inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} />{q && <Button size="sm" variant="ghost" className="h-9" onClick={() => setEntry(String(q.price))}>live</Button>}</div>
              </Field>
              <Field label="Stop-loss price"><Input type="number" inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} /></Field>
              <Field label="Take-profit (optional)"><Input type="number" inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} /></Field>
              <Field label="Leverage (perps / CFDs)" hint="Used for the margin estimate and the perpetual liquidation estimate only."><Input type="number" inputMode="decimal" value={leverage} onChange={(e) => setLeverage(e.target.value)} placeholder="e.g. 5" /></Field>
              <Field label="Instrument specification" className="sm:col-span-2">
                {custom ? (
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    <Select value={cKind} onChange={(e) => setCKind(e.target.value as InstrumentSpec["kind"])}><option value="crypto_spot">crypto spot</option><option value="crypto_perp">crypto perp</option><option value="crypto_futures_cme">crypto futures</option><option value="gold_cfd">gold CFD</option><option value="gold_futures">gold futures</option></Select>
                    <Input type="number" value={cSize} onChange={(e) => setCSize(e.target.value)} placeholder="contract size" title="Contract / lot size in base units" />
                    <Input type="number" value={cTick} onChange={(e) => setCTick(e.target.value)} placeholder="tick" title="Tick size" />
                    <Input type="number" value={cStep} onChange={(e) => setCStep(e.target.value)} placeholder="qty step" title="Quantity step" />
                    <Input type="number" value={cMin} onChange={(e) => setCMin(e.target.value)} placeholder="min qty" title="Minimum quantity" />
                  </div>
                ) : (
                  <Select value={specId} onChange={(e) => setSpecId(e.target.value)}>{relevant.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>
                )}
              </Field>
              <div className="sm:col-span-2 flex items-end"><Toggle checked={custom} onChange={setCustom} label="Custom specification" description="Enter your broker's contract size, tick, quantity step and minimum" /></div>
            </div>
            {spec && !custom && (
              <div className="mt-3 rounded-lg bg-surface-2 border border-line p-3 text-xs text-ink-2 space-y-1">
                <div className="flex flex-wrap gap-x-4 gap-y-1"><span><span className="text-ink-3">Contract size</span> {spec.contractSize} {spec.baseUnit}</span><span><span className="text-ink-3">Tick</span> {spec.tickSize} (= {fmtMoney(spec.tickSize * spec.contractSize)} per {spec.quantityUnit.replace(/s$/, "")})</span><span><span className="text-ink-3">Qty step</span> {spec.qtyStep}</span><span><span className="text-ink-3">Min qty</span> {spec.minQty}</span>{spec.minNotional && <span><span className="text-ink-3">Min notional</span> {spec.minNotional}</span>}{spec.maxLeverage && <span><span className="text-ink-3">Max leverage</span> {spec.maxLeverage}x</span>}</div>
                <div className="text-ink-3">Source: {spec.source}{spec.verified ? ` · verified ${spec.verified}` : ""}</div>
                <div className={cls(spec.kind === "gold_cfd" ? "text-warn" : "text-ink-3")}>{spec.note}</div>
              </div>
            )}
            <div className="mt-4 flex items-center gap-3">
              <Button variant="primary" disabled={!canRun} loading={size.isPending} onClick={run}>Calculate</Button>
              {size.isError && <span className="text-xs text-bear">{(size.error as Error).message}</span>}
            </div>
          </Card>

          {r && (
            <Card title="Result" subtitle={size.data?.spec.label} actions={<Badge tone={r.status === "SIZED" ? "bull" : r.status === "NO_TRADE" ? "warning" : "bear"} className="font-semibold">{r.status.replace("_", " ")}</Badge>}>
              {r.reasons.length > 0 && <div className="mb-3 space-y-1">{r.reasons.map((m, i) => <p key={i} className={cls("text-sm", r.status === "INVALID" ? "text-bear" : "text-warn")}>{m}</p>)}</div>}
              {r.status !== "INVALID" && (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <Metric label="Position size" value={r.status === "SIZED" ? `${r.quantity} ${r.quantityUnit}` : "0"} sub={r.status === "SIZED" ? `= ${r.baseUnits} ${r.baseUnit}` : undefined} big />
                  <Metric label="Monetary risk" value={fmtMoney(r.status === "SIZED" ? -r.potentialLossAccount : 0, currency)} sub={`budget ${fmtMoney(r.riskBudgetAccount, currency)} · effective ${fmtPct(r.effectiveRiskPct, 2, false)}`} tone="bear" />
                  <Metric label="Potential profit" value={r.potentialProfitAccount !== null ? fmtMoney(r.potentialProfitAccount, currency) : "—"} sub={r.riskReward !== null ? `R:R ${fmtNum(r.riskReward, 2)}` : "add a take-profit"} tone="bull" />
                  <Metric label="Stop distance" value={`${fmtPrice(r.stopDistance, asset)} (${fmtPct(r.stopDistancePct, 2, false)})`} sub={r.stopDistanceTicks !== null ? `${r.stopDistanceTicks} ticks · risk/unit ${fmtMoney(r.riskPerUnitQuote)}` : undefined} />
                  <Metric label="Notional exposure" value={fmtMoney(r.notionalAccount, currency)} sub={currency !== "USD" ? `${fmtMoney(r.notionalQuote)} USD` : undefined} />
                  <Metric label="Margin estimate" value={r.marginEstimateAccount !== null ? fmtMoney(r.marginEstimateAccount, currency) : "not computed"} sub={r.marginEstimateAccount !== null && parseFloat(balance) ? `${fmtPct((r.marginEstimateAccount / parseFloat(balance)) * 100, 1, false)} of balance` : undefined} />
                  <Metric label="Liquidation (est.)" value={r.liquidationEstimate !== null ? fmtPrice(r.liquidationEstimate, asset) : "—"} sub={r.liquidationEstimate !== null ? "isolated-margin approximation" : spec?.kind === "crypto_perp" ? "enter leverage" : "n/a for this instrument"} tone={r.liquidationEstimate !== null && ((direction === "LONG" && r.liquidationEstimate >= parseFloat(stop)) || (direction === "SHORT" && r.liquidationEstimate <= parseFloat(stop))) ? "bear" : undefined} />
                  <Metric label="Tick value" value={fmtMoney(r.tickValueQuote)} sub={`per ${r.quantityUnit.replace(/s$/, "")} per tick`} />
                </div>
              )}
              {r.status !== "INVALID" && (
                <div className="mt-4 space-y-1.5">
                  <p className="text-[11px] text-ink-3">{r.marginNote}</p>
                  {r.liquidationNote && <p className="text-[11px] text-ink-3">{r.liquidationNote}</p>}
                  {r.warnings.map((w, i) => <p key={i} className="text-xs text-warn">⚠ {w}</p>)}
                </div>
              )}
            </Card>
          )}

          <Card title="Pre-trade discipline gate" subtitle="Advisory checklist before any manual order — adapted from the pre-trade-discipline-gate methodology" actions={<Button size="sm" icon={<ShieldCheck className="h-3.5 w-3.5" />} loading={gate.isPending} onClick={runGate} disabled={!r}>Evaluate</Button>}>
            <div className="grid sm:grid-cols-3 gap-3 mb-3">
              <Toggle checked={plan.written} onChange={(v) => setPlan({ ...plan, written: v })} label="Entry is in a written plan" />
              <Toggle checked={plan.stopDefined} onChange={(v) => setPlan({ ...plan, stopDefined: v })} label="Stop was defined before entry" />
              <Toggle checked={plan.sizeOk} onChange={(v) => setPlan({ ...plan, sizeOk: v })} label="Size is within plan" />
            </div>
            {!r && <p className="text-xs text-ink-3">Calculate a position first — the gate compares planned risk (budget) with actual risk (sized position), checks for a recent losing trade, the market regime and the account circuit breaker.</p>}
            {gate.data && (
              <div className="space-y-2">
                <Badge tone={gate.data.gate.decision === "GO" ? "bull" : gate.data.gate.decision === "NO_GO" ? "bear" : "warning"} className="font-semibold text-sm px-3 py-1">{gate.data.gate.decision.replace("_", " ")}</Badge>
                <ul className="space-y-1">
                  {gate.data.gate.rules.map((x) => (
                    <li key={x.rule} className="flex items-start gap-2 text-xs"><Checkmark ok={x.passed} /><span><span className="text-ink-1 font-medium">{x.rule.replace(/_/g, " ")}</span> <span className="text-ink-2">— {x.detail}</span></span></li>
                  ))}
                </ul>
                <p className="text-[11px] text-ink-3">GO = all checks passed · REVIEW REQUIRED = something unanswered or unavailable · NO GO = a rule failed. This gate never places orders.</p>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Account circuit breaker" subtitle="Realised-P&L rules from your journal (real trades only)" loading={cb.isLoading}>
            {cb.data && (
              <div className="space-y-3">
                <Badge tone={cb.data.circuitBreaker.recommendation === "TRADING_ALLOWED" ? "bull" : cb.data.circuitBreaker.recommendation === "COOLDOWN" ? "warning" : "bear"} className="font-semibold">{cb.data.circuitBreaker.recommendation.replace("_", " ")}</Badge>
                {cb.data.circuitBreaker.triggered.map((t) => <p key={t.rule} className="text-xs text-warn">{t.detail}{t.activeUntil ? ` · until ${fmtDateTime(t.activeUntil, tz)}` : ""}</p>)}
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div className="card p-2"><div className="text-ink-3">Today</div><div className={cls("tabular font-medium", cb.data.circuitBreaker.metrics.dailyPnl >= 0 ? "text-bull" : "text-bear")}>{fmtMoney(cb.data.circuitBreaker.metrics.dailyPnl, currency)}</div></div>
                  <div className="card p-2"><div className="text-ink-3">Week</div><div className={cls("tabular font-medium", cb.data.circuitBreaker.metrics.weeklyPnl >= 0 ? "text-bull" : "text-bear")}>{fmtMoney(cb.data.circuitBreaker.metrics.weeklyPnl, currency)}</div></div>
                  <div className="card p-2"><div className="text-ink-3">Month</div><div className={cls("tabular font-medium", cb.data.circuitBreaker.metrics.monthlyPnl >= 0 ? "text-bull" : "text-bear")}>{fmtMoney(cb.data.circuitBreaker.metrics.monthlyPnl, currency)}</div></div>
                </div>
                <div>
                  <div className="flex justify-between text-xs text-ink-3 mb-1"><span>Portfolio heat (open risk)</span><span className={cls("tabular", cb.data.heat.status === "ok" ? "text-ink-1" : cb.data.heat.status === "elevated" ? "text-warn" : "text-bear")}>{fmtPct(cb.data.heat.heatPct, 2, false)}</span></div>
                  <Meter value={Math.min(100, (cb.data.heat.heatPct / 10) * 100)} tone={cb.data.heat.status === "ok" ? "accent" : cb.data.heat.status === "elevated" ? "warning" : "bear"} thresholds={[{ at: 60, label: "6%" }, { at: 80, label: "8%" }]} label="Portfolio heat" />
                  <p className="text-[10.5px] text-ink-3 mt-1">Guideline: total open risk ≤ 6–8% of equity. Rules: daily −2% halt · 2 consecutive losers → 24h cooldown · weekly −5% · monthly −8%.</p>
                </div>
              </div>
            )}
          </Card>
          <Card title="Instrument reference" subtitle="Verified contract specifications" padded={false}>
            <table className="w-full text-xs">
              <thead><tr className="text-left text-ink-3"><th className="px-4 py-2 font-medium">Instrument</th><th className="px-2 py-2 font-medium text-right">Size</th><th className="px-2 py-2 font-medium text-right">Tick</th><th className="px-4 py-2 font-medium text-right">$/tick</th></tr></thead>
              <tbody>
                {specs.map((s) => (
                  <tr key={s.id} className={cls("border-t border-line", s.id === specId && "bg-surface-2")}>
                    <td className="px-4 py-1.5 text-ink-1"><Tooltip content={`${s.source}${s.verified ? ` · verified ${s.verified}` : ""} — ${s.note}`}><span className="cursor-help">{s.label}</span></Tooltip></td>
                    <td className="px-2 py-1.5 tabular text-right text-ink-2">{s.contractSize} {s.baseUnit}</td>
                    <td className="px-2 py-1.5 tabular text-right text-ink-2">{s.tickSize}</td>
                    <td className="px-4 py-1.5 tabular text-right text-ink-2">{fmtMoney(s.tickSize * s.contractSize)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-4 py-2 text-[10.5px] text-ink-3 border-t border-line">Not all brokers use 100 oz gold lots or the same leverage; CFD rows are conventions — use the custom specification for your broker's contract.</p>
          </Card>
          <Disclaimer />
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, sub, tone, big }: { label: string; value: string; sub?: string; tone?: "bull" | "bear"; big?: boolean }) {
  return (
    <div className="card p-3 min-w-0">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className={cls("font-semibold tabular truncate", big ? "text-xl" : "text-base", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-ink-1")} title={value}>{value}</div>
      {sub && <div className="text-[10.5px] text-ink-3 truncate" title={sub}>{sub}</div>}
    </div>
  );
}

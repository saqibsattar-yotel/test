import { useState } from "react";
import { Save, Sparkles } from "lucide-react";
import { assetBase, type AssetId, type Timeframe } from "@terminal/core";
import { Badge, Button, Card, DataNotice, Disclaimer, PageHeader, Segmented, Tooltip } from "@/components/ui";
import { AssetPicker } from "@/components/ui/AssetPicker";
import { useAssetLabel } from "@/lib/assets";
import { MtfMatrix } from "@/components/charts/MtfMatrix";
import { NarrativeBlock } from "@/components/setups/NarrativeBlock";
import { useAnalysis, useNarrativeMutation, useSavedAnalysisMutations, useSettings } from "@/lib/queries";
import { useUiNoQuotes } from "@/lib/store";
import { cls, fmtNum, fmtPct, fmtPrice } from "@/lib/format";

const ALL: Timeframe[] = ["5m", "15m", "1h", "4h", "1d", "1w"];

export default function Technical() {
  const ui = useUiNoQuotes();
  const asset = ui.selectedAsset;
  const settings = useSettings();
  const L = useAssetLabel();
  const quick = Array.from(new Set<AssetId>([...(settings.data?.settings.followedAssets ?? ["BTCUSD", "ETHUSD", "SOLUSD", "XAUUSD"]), asset])).slice(-8);
  const [tfs, setTfs] = useState<Timeframe[]>(["15m", "1h", "4h", "1d"]);
  const analysis = useAnalysis(asset, tfs);
  const narrative = useNarrativeMutation();
  const saved = useSavedAnalysisMutations();
  const pushToast = ui.pushToast;
  const a = analysis.data;
  const toggle = (t: Timeframe) => setTfs(tfs.includes(t) ? (tfs.length > 2 ? tfs.filter((x) => x !== t) : tfs) : ALL.filter((x) => tfs.includes(x) || x === t));
  return (
    <div className="space-y-4">
      <PageHeader
        title="Technical Analysis"
        description="Multi-timeframe engine: independent bias per timeframe, weighted alignment, key levels, confirmation requirements and explicit invalidation. Contradictions are explained, not hidden."
        actions={
          <>
            <Segmented size="sm" options={quick.map((x) => ({ value: x, label: assetBase(x) }))} value={asset} onChange={(v) => ui.setSelectedAsset(v as AssetId)} />
            <AssetPicker size="sm" className="w-56" placeholder="Any asset…" onSelect={(id) => ui.setSelectedAsset(id as AssetId)} />
            <div className="flex gap-1">
              {ALL.map((t) => (
                <button key={t} onClick={() => toggle(t)} aria-pressed={tfs.includes(t)} className={cls("h-8 px-2.5 rounded-md border text-xs font-medium", tfs.includes(t) ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-ink-3")}>
                  {t}
                </button>
              ))}
            </div>
          </>
        }
      />
      {a && <DataNotice sources={a.sources} warnings={a.warnings} />}
      <Card title={`${L(asset).symbol} · bias by timeframe`} subtitle="Hover a cell for the evidence behind it" loading={analysis.isLoading} error={analysis.isError ? (analysis.error as Error).message : null} onRetry={() => analysis.refetch()}>
        {a && <MtfMatrix perTimeframe={a.mtf.perTimeframe} />}
      </Card>
      {a && (
        <>
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3">
            <Card title="Overall directional bias">
              <p className={cls("text-2xl font-semibold capitalize", a.mtf.overallBias === "bullish" ? "text-bull" : a.mtf.overallBias === "bearish" ? "text-bear" : "text-ink-1")}>{a.mtf.overallBias}</p>
              <p className="text-xs text-ink-3 mt-1">Weighted score {a.mtf.overallScore} (±8) · {a.mtf.alignmentPct}% alignment · {a.mtf.alignment}</p>
              <p className="text-xs mt-2">
                <Badge tone={a.mtf.worthConsidering ? "bull" : "muted"}>{a.mtf.worthConsidering ? "Worth considering a plan" : "Not worth forcing"}</Badge>
              </p>
            </Card>
            <Card title="Key levels">
              <div className="space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-ink-3">Resistance</span><span className="tabular text-bear font-medium">{fmtPrice(a.mtf.keyResistance, asset)}</span></div>
                <div className="flex justify-between"><span className="text-ink-3">Price</span><span className="tabular text-ink-1 font-medium">{fmtPrice(a.price, asset)}</span></div>
                <div className="flex justify-between"><span className="text-ink-3">Support</span><span className="tabular text-bull font-medium">{fmtPrice(a.mtf.keySupport, asset)}</span></div>
              </div>
            </Card>
            <Card title="Potential entry area">
              {a.mtf.entryArea ? (
                <>
                  <p className="text-lg font-semibold tabular text-accent">{fmtPrice(a.mtf.entryArea.low, asset)} – {fmtPrice(a.mtf.entryArea.high, asset)}</p>
                  <p className="text-xs text-ink-3 mt-1">{a.mtf.entryArea.basis}</p>
                </>
              ) : (
                <p className="text-sm text-ink-3">No entry area while the bias is neutral or timeframes conflict.</p>
              )}
            </Card>
            <Card title="Volatility">
              <div className="space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-ink-3">4h ATR</span><span className="tabular">{a.volatility.atrPct4h?.toFixed(2) ?? "—"}%</span></div>
                <div className="flex justify-between"><span className="text-ink-3">Daily ATR</span><span className="tabular">{a.volatility.atrPct1d?.toFixed(2) ?? "—"}%</span></div>
                <div className="flex justify-between"><span className="text-ink-3">30d realised vol</span><span className="tabular">{a.volatility.realizedVol30dPct?.toFixed(0) ?? "—"}%</span></div>
              </div>
            </Card>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <Card title="Confirmation requirements" subtitle="What must happen before acting">
              {a.mtf.confirmations.length ? <ul className="list-disc pl-5 space-y-1 text-sm text-ink-2">{a.mtf.confirmations.map((c, i) => <li key={i}>{c}</li>)}</ul> : <p className="text-sm text-ink-3">No directional thesis to confirm.</p>}
            </Card>
            <Card title="Invalidating conditions" subtitle="Where the read is wrong">
              {a.mtf.invalidations.length ? <ul className="list-disc pl-5 space-y-1 text-sm text-ink-2">{a.mtf.invalidations.map((c, i) => <li key={i}>{c}</li>)}</ul> : <p className="text-sm text-ink-3">—</p>}
            </Card>
          </div>

          {a.mtf.conflicts.length > 0 && (
            <Card title="Timeframe differences explained">
              <ul className="space-y-1.5 text-sm text-ink-2">
                {a.mtf.conflicts.map((c, i) => (
                  <li key={i} className="flex gap-2"><span className="text-warn">•</span><span>{c}</span></li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="Indicator matrix" padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-ink-3">
                    <th className="px-4 py-2 font-medium">TF</th>
                    <th className="px-2 py-2 font-medium">Bias</th>
                    <th className="px-2 py-2 font-medium">Structure</th>
                    <th className="px-2 py-2 font-medium text-right">RSI</th>
                    <th className="px-2 py-2 font-medium text-right">MACD hist</th>
                    <th className="px-2 py-2 font-medium text-right">EMA 20</th>
                    <th className="px-2 py-2 font-medium text-right">EMA 50</th>
                    <th className="px-2 py-2 font-medium text-right">EMA 200</th>
                    <th className="px-2 py-2 font-medium text-right">ADX</th>
                    <th className="px-2 py-2 font-medium text-right">ATR %</th>
                    <th className="px-4 py-2 font-medium text-right">Data</th>
                  </tr>
                </thead>
                <tbody>
                  {a.mtf.perTimeframe.map((p) => {
                    const i = p.indicators;
                    const t = p.bias === "bullish" ? "text-bull" : p.bias === "bearish" ? "text-bear" : "text-ink-2";
                    return (
                      <tr key={p.timeframe} className="border-t border-line">
                        <td className="px-4 py-1.5 font-semibold text-ink-1">{p.timeframe}</td>
                        <td className={cls("px-2 py-1.5 capitalize font-medium", t)}>{p.bias} <span className="text-ink-3 font-normal">{p.strength}%</span></td>
                        <td className="px-2 py-1.5 capitalize text-ink-2">{p.trend}</td>
                        <td className={cls("px-2 py-1.5 tabular text-right", i.rsi14 >= 70 ? "text-bear" : i.rsi14 <= 30 ? "text-bull" : "text-ink-2")}>{fmtNum(i.rsi14, 1)}</td>
                        <td className={cls("px-2 py-1.5 tabular text-right", i.macd.histogram >= 0 ? "text-bull" : "text-bear")}>{fmtNum(i.macd.histogram, 2)}</td>
                        <td className={cls("px-2 py-1.5 tabular text-right", i.close > i.ema20 ? "text-bull" : "text-bear")}>{fmtPrice(i.ema20, asset)}</td>
                        <td className={cls("px-2 py-1.5 tabular text-right", i.close > i.ema50 ? "text-bull" : "text-bear")}>{fmtPrice(i.ema50, asset)}</td>
                        <td className={cls("px-2 py-1.5 tabular text-right", Number.isFinite(i.ema200) ? (i.close > i.ema200 ? "text-bull" : "text-bear") : "text-ink-3")}>{Number.isFinite(i.ema200) ? fmtPrice(i.ema200, asset) : "n/a"}</td>
                        <td className="px-2 py-1.5 tabular text-right text-ink-2">{fmtNum(i.adx14, 0)}</td>
                        <td className="px-2 py-1.5 tabular text-right text-ink-2">{fmtPct(i.atrPct, 2, false)}</td>
                        <td className="px-4 py-1.5 text-right">
                          <Tooltip content={p.quality.issues.length ? p.quality.issues.map((x) => x.message).join("; ") : "No issues"}>
                            <span className={cls("cursor-help", p.quality.stale ? "text-warn" : p.quality.ok ? "text-bull" : "text-bear")}>{p.quality.stale ? "stale" : p.quality.ok ? "ok" : "issues"} · {p.bars}</span>
                          </Tooltip>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Narrative" actions={<div className="flex gap-2"><Button size="sm" variant="ghost" icon={<Save className="h-3.5 w-3.5" />} loading={saved.save.isPending} onClick={() => saved.save.mutate({ title: `${L(asset).symbol} MTF · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, payload: { assetId: asset, mtf: a.mtf, narrative: narrative.data?.narrative ?? null, asOf: a.asOf } }, { onSuccess: () => pushToast({ title: "Analysis saved", body: "Find it under Settings → Saved analyses", tone: "bull" }) })}>Save analysis</Button><Button size="sm" icon={<Sparkles className="h-3.5 w-3.5" />} loading={narrative.isPending} onClick={() => narrative.mutate({ kind: "mtf", assetId: asset })}>{narrative.data ? "Regenerate" : "Explain"}</Button></div>}>
            {narrative.data ? <NarrativeBlock narrative={narrative.data.narrative} /> : <ul className="space-y-1 text-sm text-ink-2">{a.mtfExplanation.map((l, i) => <li key={i}>{l}</li>)}</ul>}
          </Card>
          <Disclaimer />
        </>
      )}
    </div>
  );
}

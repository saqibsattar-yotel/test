import { useMemo, useState } from "react";
import { assetBase, TIMEFRAMES, type AssetId, type Level, type Timeframe } from "@terminal/core";
import { AssetPicker } from "@/components/ui/AssetPicker";
import { useAssetLabel } from "@/lib/assets";
import { Badge, Card, DataNotice, Disclaimer, ErrorState, PageHeader, Segmented, SkeletonBlock, SourceBadge, Sparkline, Stat, Tooltip } from "@/components/ui";
import { PriceChart, OverlayToolbar, DEFAULT_OVERLAYS, type OverlayToggles } from "@/components/charts/PriceChart";
import { RegimeMeter } from "@/components/charts/RegimeMeter";
import { MtfMatrix } from "@/components/charts/MtfMatrix";
import { useAnalysis, useCandles, useCryptoRegime, useFunding, useLiquidations, useOpenInterest, useSettings } from "@/lib/queries";
import { useUi, useUiNoQuotes } from "@/lib/store";
import { cls, fmtCompact, fmtMoney, fmtNum, fmtPct, fmtPrice, toneForChange } from "@/lib/format";
import { IndicatorPanel, StructurePanel, LevelsTable } from "@/components/analysis/Panels";

export default function Crypto() {
  const ui = useUiNoQuotes();
  const asset = ui.selectedCrypto;
  const settings = useSettings();
  const L = useAssetLabel();
  const meta = L(asset);
  const quick = useMemo(() => Array.from(new Set<AssetId>([...(settings.data?.settings.followedAssets ?? ["BTCUSD", "ETHUSD", "SOLUSD"]).filter((a) => a !== "XAUUSD"), asset])).slice(-8), [settings.data, asset]);
  const [tf, setTf] = useState<Timeframe>(ui.selectedTimeframe);
  const [overlays, setOverlays] = useState<OverlayToggles>(DEFAULT_OVERLAYS);
  const candles = useCandles(asset, tf, tf === "1w" ? 300 : 600);
  const analysis = useAnalysis(asset, ["5m", "15m", "1h", "4h", "1d", "1w"]);
  const regime = useCryptoRegime();
  const funding = useFunding();
  const fundingSel = useFunding([asset]);
  const oi = useOpenInterest(asset);
  const liq = useLiquidations();
  const q = useUi((s) => s.quotes[asset]);
  const a = analysis.data;
  const detail = a?.details.find((d) => d.timeframe === tf) ?? a?.details.find((d) => d.timeframe === "4h");
  const levels: Level[] = useMemo(() => {
    if (!detail) return [];
    const out: Level[] = [...detail.support, ...detail.resistance];
    if (a?.liquidity) out.push(...a.liquidity);
    return out;
  }, [detail, a]);
  const myFunding = fundingSel.data?.funding.find((f) => f.assetId === asset) ?? funding.data?.funding.find((f) => f.assetId === asset);
  const sym = `${assetBase(asset)}USDT`;
  const liqSym = liq.data?.perSymbol[sym];
  const oiData = oi.data && !("error" in oi.data) ? oi.data : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Crypto Analysis"
        description="Spot structure, derivatives positioning and multi-timeframe technicals for the major coins. Short-term direction is separated from the higher-timeframe trend."
        actions={
          <>
            <Segmented size="sm" options={quick.map((c) => ({ value: c, label: assetBase(c) }))} value={asset} onChange={(v) => { ui.setSelectedCrypto(v as AssetId); ui.setSelectedAsset(v as AssetId); }} />
            <AssetPicker size="sm" className="w-60" cryptoOnly placeholder="Any coin — POL, ENA, SUI…" onSelect={(id) => { ui.setSelectedCrypto(id as AssetId); ui.setSelectedAsset(id as AssetId); }} />
            <Segmented size="sm" options={TIMEFRAMES.map((t) => ({ value: t, label: t }))} value={tf} onChange={(t) => { setTf(t); ui.setSelectedTimeframe(t); }} />
          </>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Stat label={`${meta.symbol} · ${meta.name}`} value={q ? fmtPrice(q.price, asset) : "—"} delta={q ? fmtPct(q.changePct24h) : undefined} deltaTone={toneForChange(q?.changePct24h)} sub={q ? `24h range ${fmtPrice(q.low24h, asset)} – ${fmtPrice(q.high24h, asset)}` : undefined} big>
          {q && <SourceBadge source={q.source} compact />}
        </Stat>
        <Stat label="24h volume" value={q?.volume24hQuote ? `$${fmtCompact(q.volume24hQuote, 2)}` : "—"} sub={q?.volume24hBase ? `${fmtCompact(q.volume24hBase, 1)} ${meta.base}` : undefined} hint="Rolling 24h spot volume on the quoting venue." />
        <Stat label="Funding (8h)" hint="Latest perpetual funding settlement. Positive = longs pay shorts; above 0.03% is crowded." value={myFunding ? `${(myFunding.fundingRate * 100).toFixed(4)}%` : fundingSel.data?.error || fundingSel.data?.funding.length === 0 ? "no perp" : "—"} delta={myFunding ? `${myFunding.annualizedPct.toFixed(1)}% ann.` : undefined} deltaTone={myFunding ? (myFunding.fundingRate > 0.0003 ? "bear" : myFunding.fundingRate < 0 ? "bull" : "neutral") : "muted"} sub={myFunding?.markPrice ? `mark ${fmtPrice(myFunding.markPrice, asset)}` : fundingSel.data && !myFunding ? "no USDT perpetual on the quoting venue" : undefined}>
          {myFunding && <SourceBadge source={myFunding.source} compact />}
        </Stat>
        <Stat label="Open interest" hint="Outstanding perpetual contracts on the quoting venue; 24h change compares hourly history end-points." value={oiData ? `${fmtCompact(oiData.openInterestBase, 2)} ${meta.base}` : oi.data && "error" in oi.data ? "n/a" : "—"} delta={oiData?.change24hPct !== null && oiData?.change24hPct !== undefined ? fmtPct(oiData.change24hPct) : undefined} deltaTone={toneForChange(oiData?.change24hPct)} sub={oiData?.openInterestQuote ? `$${fmtCompact(oiData.openInterestQuote, 2)} · L/S ${oiData.longShortRatio?.toFixed(2) ?? "—"}` : undefined}>
          {oiData && <Sparkline values={oiData.history.map((h) => h.oiQuote)} tone="muted" width={72} height={22} />}
        </Stat>
        <Stat label="Liquidations (24h)" hint="Aggregated from the exchange force-order stream since this server started; understates true totals." value={liqSym ? `$${fmtCompact(liqSym.longUsd + liqSym.shortUsd, 1)}` : liq.data ? "$0" : "—"} sub={liqSym ? `longs $${fmtCompact(liqSym.longUsd, 1)} · shorts $${fmtCompact(liqSym.shortUsd, 1)}` : liq.data ? `coverage ${Math.round(liq.data.coverageMs / 60000)} min` : undefined}>
          {liq.data && <SourceBadge source={liq.data.source} compact />}
        </Stat>
        <Stat label="Volatility" hint="ATR(14) as % of price on the 4h and daily; 30-day realised volatility annualised from daily closes." value={a?.volatility.atrPct4h ? `${a.volatility.atrPct4h.toFixed(2)}% 4h ATR` : "—"} sub={a ? `daily ATR ${a.volatility.atrPct1d?.toFixed(2) ?? "—"}% · 30d RV ${a.volatility.realizedVol30dPct?.toFixed(0) ?? "—"}%` : undefined} />
      </div>

      {(candles.data || a) && <DataNotice sources={[candles.data?.source, ...(a?.sources ?? [])]} warnings={[...(candles.data?.warnings ?? []), ...(a?.warnings ?? [])]} />}

      <div className="grid xl:grid-cols-[minmax(0,1fr)_380px] gap-4">
        <div className="space-y-4 min-w-0">
          <Card title={`${meta.symbol} · ${tf}`} subtitle="Candles with EMA 20/50/100/200, Bollinger, VWAP, structural levels; RSI and MACD panes synced below." padded={false} source={candles.data?.source}>
            <div className="px-3 pt-3">
              <OverlayToolbar value={overlays} onChange={setOverlays} />
            </div>
            {candles.isLoading ? <div className="skeleton h-[640px] m-4" /> : candles.isError ? <ErrorState message={(candles.error as Error).message} retry={() => candles.refetch()} /> : candles.data ? <PriceChart assetId={asset} timeframe={tf} candles={candles.data.candles} overlays={overlays} levels={levels} height={400} /> : null}
          </Card>

          <Card title="Multi-timeframe read" subtitle="Each timeframe scored independently; higher timeframes weigh more in the overall bias." loading={analysis.isLoading} error={analysis.isError ? (analysis.error as Error).message : null} onRetry={() => analysis.refetch()}>
            {a && (
              <div className="space-y-4">
                <MtfMatrix perTimeframe={a.mtf.perTimeframe} selected={tf} onSelect={(t) => setTf(t)} />
                <div className="grid sm:grid-cols-3 gap-3 text-sm">
                  <div className="card p-3">
                    <p className="text-[11px] text-ink-3 uppercase tracking-wider">Overall bias</p>
                    <p className={cls("text-lg font-semibold capitalize", a.mtf.overallBias === "bullish" ? "text-bull" : a.mtf.overallBias === "bearish" ? "text-bear" : "text-ink-1")}>{a.mtf.overallBias}</p>
                    <p className="text-xs text-ink-3">{a.mtf.alignmentPct}% of weight agrees · {a.mtf.alignment}</p>
                  </div>
                  <div className="card p-3">
                    <p className="text-[11px] text-ink-3 uppercase tracking-wider">Key support</p>
                    <p className="text-lg font-semibold tabular text-bull">{fmtPrice(a.mtf.keySupport, asset)}</p>
                    <p className="text-xs text-ink-3">{a.mtf.keySupport ? `${fmtPct(((a.mtf.keySupport - a.price) / a.price) * 100)} from price` : "—"}</p>
                  </div>
                  <div className="card p-3">
                    <p className="text-[11px] text-ink-3 uppercase tracking-wider">Key resistance</p>
                    <p className="text-lg font-semibold tabular text-bear">{fmtPrice(a.mtf.keyResistance, asset)}</p>
                    <p className="text-xs text-ink-3">{a.mtf.keyResistance ? `${fmtPct(((a.mtf.keyResistance - a.price) / a.price) * 100)} from price` : "—"}</p>
                  </div>
                </div>
                <ul className="space-y-1 text-sm text-ink-2">
                  {a.mtfExplanation.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
                {a.mtf.conflicts.length > 0 && (
                  <div className="rounded-lg bg-[rgba(250,178,25,0.1)] px-3 py-2 text-xs text-ink-2">
                    <span className="font-medium text-warn">Timeframe conflicts: </span>
                    {a.mtf.conflicts[0]}
                  </div>
                )}
              </div>
            )}
          </Card>

          <div className="grid lg:grid-cols-2 gap-4">
            <Card title="Market structure" subtitle={`${detail?.timeframe ?? tf} swings, breakouts, higher highs / lower lows`} loading={analysis.isLoading}>
              {detail?.structure && <StructurePanel structure={detail.structure} assetId={asset} price={a?.price ?? 0} />}
            </Card>
            <Card title="Support & resistance" subtitle={`Clustered swing levels on the ${detail?.timeframe ?? tf}`} loading={analysis.isLoading} padded={false}>
              {detail && <LevelsTable support={detail.support} resistance={detail.resistance} liquidity={a?.liquidity ?? []} assetId={asset} price={a?.price ?? 0} />}
            </Card>
          </div>
        </div>

        <div className="space-y-4 min-w-0">
          <Card title={`Indicators · ${detail?.timeframe ?? tf}`} subtitle={detail ? `${detail.bars} bars · ${detail.quality.ok ? "data OK" : "data issues"}` : undefined} source={detail?.source} loading={analysis.isLoading}>
            {detail?.indicators && <IndicatorPanel ind={detail.indicators} assetId={asset} />}
          </Card>
          <Card title="Crypto market regime" subtitle="Adapted from the crypto-regime-analyzer methodology (6 components)" source={regime.data?.sources} loading={regime.isLoading} error={regime.isError ? (regime.error as Error).message : null} onRetry={() => regime.refetch()}>
            {regime.data && (
              <div className="space-y-3">
                <RegimeMeter score={regime.data.result.score} zone={regime.data.result.zone} components={regime.data.result.components} effectiveWeights={regime.data.result.effectiveWeights} />
                {regime.data.notes.length > 0 && (
                  <ul className="text-[11px] text-ink-3 space-y-0.5">
                    {regime.data.notes.map((n, i) => (
                      <li key={i}>• {n}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Card>
          <Card title="Perpetual funding · all majors" subtitle="Latest 8h rate; bars scaled to ±0.05%" source={funding.data?.funding[0]?.source} loading={funding.isLoading}>
            {funding.data?.funding.length ? (
              <ul className="space-y-1.5">
                {[...funding.data.funding]
                  .sort((x, y) => y.fundingRate - x.fundingRate)
                  .map((f) => {
                    const pct = f.fundingRate * 100;
                    const w = Math.min(50, (Math.abs(pct) / 0.05) * 50);
                    return (
                      <li key={f.symbol} className="grid grid-cols-[48px_1fr_72px] items-center gap-2 text-xs">
                        <span className={cls("font-medium", f.assetId === asset ? "text-ink-1" : "text-ink-2")}>{assetBase(f.assetId)}</span>
                        <div className="relative h-2 bg-surface-3 rounded-full overflow-hidden">
                          <div className="absolute top-0 bottom-0 w-px bg-ink-3/40 left-1/2" />
                          <div className={cls("absolute top-0 h-full rounded-full", pct >= 0 ? "bg-bear left-1/2" : "bg-bull right-1/2")} style={{ width: `${w}%` }} />
                        </div>
                        <Tooltip content={`${f.annualizedPct.toFixed(1)}% annualised`}>
                          <span className={cls("tabular text-right cursor-help", pct > 0.03 ? "text-bear" : pct < 0 ? "text-bull" : "text-ink-2")}>{pct.toFixed(4)}%</span>
                        </Tooltip>
                      </li>
                    );
                  })}
              </ul>
            ) : (
              <p className="text-xs text-ink-3">{funding.data?.error ?? "Funding unavailable."}</p>
            )}
          </Card>
          {liq.data && (
            <Card title="Liquidations · largest recent" subtitle="Force orders observed since server start" source={liq.data.source}>
              {liq.data.largest.length ? (
                <ul className="space-y-1 text-xs">
                  {liq.data.largest.slice(0, 8).map((l, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <Badge tone={l.side === "LONG" ? "bear" : "bull"} size="sm">
                        {l.side} liq
                      </Badge>
                      <span className="text-ink-2">{l.symbol.replace("USDT", "")}</span>
                      <span className="ml-auto tabular text-ink-1">{fmtMoney(l.usd, "USD", 0)}</span>
                      <span className="tabular text-ink-3">@ {fmtNum(l.price, 2)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-ink-3">No liquidations observed yet ({Math.round(liq.data.coverageMs / 60000)} min of coverage).</p>
              )}
            </Card>
          )}
          <Disclaimer />
        </div>
      </div>
      {analysis.isLoading && <SkeletonBlock lines={1} />}
    </div>
  );
}

import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { TIMEFRAMES, type DataSource, type Level, type Timeframe } from "@terminal/core";
import { Badge, Button, Card, DataNotice, Disclaimer, ErrorState, PageHeader, Segmented, SourceBadge, Sparkline, Stat, Tooltip, type Tone } from "@/components/ui";
import { PriceChart, OverlayToolbar, DEFAULT_OVERLAYS, type OverlayToggles } from "@/components/charts/PriceChart";
import { RegimeMeter } from "@/components/charts/RegimeMeter";
import { MtfMatrix } from "@/components/charts/MtfMatrix";
import { NarrativeBlock } from "@/components/setups/NarrativeBlock";
import { IndicatorPanel, LevelsTable, StructurePanel } from "@/components/analysis/Panels";
import { useAnalysis, useCalendar, useCandles, useDxy, useGoldInstruments, useGoldRegime, useGoldVerification, useIntel, useMacro, useNarrativeMutation } from "@/lib/queries";
import { useUi, useUiNoQuotes } from "@/lib/store";
import { cls, fmtAge, fmtDateTime, fmtNum, fmtPct, fmtPrice, fmtSigned, fmtUntil, toneForChange } from "@/lib/format";
import type { GoldVerification, MacroSeries } from "@/lib/api";

const ASSET = "XAUUSD" as const;

export default function Gold() {
  const ui = useUiNoQuotes();
  const [tf, setTf] = useState<Timeframe>(ui.selectedTimeframe === "5m" ? "15m" : ui.selectedTimeframe);
  const [overlays, setOverlays] = useState<OverlayToggles>({ ...DEFAULT_OVERLAYS, vwap: true });
  const candles = useCandles(ASSET, tf, tf === "1w" ? 300 : 600);
  const analysis = useAnalysis(ASSET, ["15m", "1h", "4h", "1d", "1w"]);
  const posture = useGoldRegime();
  const macro = useMacro();
  const intel = useIntel();
  const dxy = useDxy();
  const instruments = useGoldInstruments();
  const verification = useGoldVerification();
  const [now] = useState(() => Date.now());
  const cal = useCalendar({ from: new Date(now - 6 * 3600_000).toISOString(), to: new Date(now + 14 * 86_400_000).toISOString(), markets: "gold,rates" });
  const narrative = useNarrativeMutation();
  const q = useUi((s) => s.quotes[ASSET]);
  const a = analysis.data;
  const tz = ui.timezone;
  const detail = a?.details.find((d) => d.timeframe === tf) ?? a?.details.find((d) => d.timeframe === "1h");
  const daily = a?.details.find((d) => d.timeframe === "1d");
  const weekly = a?.mtf.perTimeframe.find((p) => p.timeframe === "1w");
  const levels: Level[] = useMemo(() => {
    if (!detail) return [];
    const out: Level[] = [...detail.support, ...detail.resistance, ...(a?.liquidity ?? [])];
    const pl = a?.periodLevels;
    if (pl) {
      if (pl.prevDayHigh) out.push({ price: pl.prevDayHigh, kind: "prev_day_high", label: "Prev day high", strength: 0.5 });
      if (pl.prevDayLow) out.push({ price: pl.prevDayLow, kind: "prev_day_low", label: "Prev day low", strength: 0.5 });
      if (pl.prevWeekHigh) out.push({ price: pl.prevWeekHigh, kind: "prev_week_high", label: "Prev week high", strength: 0.55 });
      if (pl.prevWeekLow) out.push({ price: pl.prevWeekLow, kind: "prev_week_low", label: "Prev week low", strength: 0.55 });
    }
    return out;
  }, [detail, a]);
  const closed = q?.source.quality === "closed";
  const atr1h = a?.details.find((d) => d.timeframe === "1h")?.indicators?.atr14;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Gold Analysis"
        description="XAU/USD workspace: daily and weekly trend, intraday structure, session ranges, liquidity and the macro backdrop (dollar, real yields, Fed). Verified data is separated from interpretation."
        actions={
          <>
            <OverlayToolbar value={overlays} onChange={setOverlays} />
            <Segmented size="sm" options={TIMEFRAMES.filter((t) => t !== "5m").map((t) => ({ value: t, label: t }))} value={tf} onChange={(t) => { setTf(t); ui.setSelectedTimeframe(t); }} />
          </>
        }
      />

      {closed && q && <DataNotice sources={[q.source]} warnings={["Spot gold is closed (it trades Sunday ~22:00 to Friday ~22:00 UTC). Prices and levels reflect the last quotes before the close; nothing updates until the market reopens."]} />}
      {a && <DataNotice warnings={a.warnings} />}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Stat label="XAU/USD" value={q ? fmtPrice(q.price, ASSET) : "—"} delta={q ? fmtPct(q.changePct24h) : undefined} deltaTone={toneForChange(q?.changePct24h)} sub={q ? `${q.source.provider === "twelvedata" ? "vs previous close" : "24h"} · range ${fmtPrice(q.low24h, ASSET)} – ${fmtPrice(q.high24h, ASSET)}` : undefined} big>
          {q && <SourceBadge source={q.source} compact />}
        </Stat>
        <Stat label="Daily trend" value={daily?.structure ? daily.structure.trend : "—"} delta={daily?.indicators ? `EMA ${daily.indicators.emaStack}` : undefined} deltaTone={daily?.indicators?.emaStack === "bullish" ? "bull" : daily?.indicators?.emaStack === "bearish" ? "bear" : "neutral"} sub={daily?.indicators ? `RSI ${fmtNum(daily.indicators.rsi14, 1)} · ${daily.indicators.close > daily.indicators.ema200 ? "above" : "below"} EMA200` : undefined} />
        <Stat label="Weekly bias" value={weekly ? weekly.bias : "—"} delta={weekly ? `${weekly.strength}%` : undefined} deltaTone={weekly?.bias === "bullish" ? "bull" : weekly?.bias === "bearish" ? "bear" : "neutral"} sub={weekly?.trend} />
        <Stat label="Gold posture" hint="Macro-technical composite: trend, dollar (measured correlation), real yields, momentum, volatility." value={posture.data ? (posture.data.result.score === null ? "UNKNOWN" : posture.data.result.score.toFixed(0)) : "—"} delta={posture.data?.result.zone} deltaTone={posture.data?.result.zone === "CONSTRUCTIVE" ? "bull" : posture.data?.result.zone === "DEFENSIVE" ? "bear" : "warning"} />
        <Stat label="Volatility" value={atr1h ? `${fmtPrice(atr1h, ASSET)} 1h ATR` : "—"} sub={a ? `4h ATR ${a.volatility.atrPct4h?.toFixed(2) ?? "—"}% · daily ${a.volatility.atrPct1d?.toFixed(2) ?? "—"}% · 30d RV ${a.volatility.realizedVol30dPct?.toFixed(0) ?? "—"}%` : undefined} />
        <Stat label="US Dollar Index" hint="ICE DXY formula applied to live bank FX quotes (Swissquote); history from the Dukascopy FX archive. The index definition itself, not the licensed ICE print." value={dxy.data && Number.isFinite(dxy.data.value) ? fmtNum(dxy.data.value, 2) : macro.data?.dxy ? fmtNum(macro.data.dxy.latest, 2) : "—"} delta={macro.data?.dxy?.change20d !== null && macro.data?.dxy?.change20d !== undefined ? `${fmtSigned(macro.data.dxy.change20d, 2)} / 20d` : undefined} deltaTone={macro.data?.dxy?.change20d ? (macro.data.dxy.change20d > 0 ? "bear" : "bull") : "neutral"} sub={dxy.data?.archiveLastClose ? `archive close ${fmtNum(dxy.data.archiveLastClose.value, 2)} · ${fmtDateTime(dxy.data.archiveLastClose.time, tz)}` : undefined}>
          {dxy.data ? <SourceBadge source={dxy.data.source} compact /> : macro.data?.dxy ? <SourceBadge source={macro.data.dxy.source} compact /> : null}
        </Stat>
      </div>

      <div className="grid xl:grid-cols-2 gap-4">
        <Card title="Spot · futures · tokenised gold" subtitle="Three different prices for “gold” — every analysis on this page uses spot XAU/USD only" loading={instruments.isLoading} error={instruments.isError ? (instruments.error as Error).message : null} onRetry={() => instruments.refetch()}>
          {instruments.data && (
            <div className="grid sm:grid-cols-3 gap-3">
              <InstrumentTile title="Spot XAU/USD" tag="analysed here" tagTone="gold" price={instruments.data.spot ? fmtPrice(instruments.data.spot.quote.price, ASSET) : "—"} source={instruments.data.spot?.quote.source ?? null} lines={[instruments.data.spot?.kind ?? "Spot quote unavailable", instruments.data.spot ? `Trades ${instruments.data.spot.tradesWhen}.` : ""]} />
              <InstrumentTile title="COMEX futures (GC)" tag="no live feed" tagTone="muted" price="—" source={null} lines={[instruments.data.futures.kind, instruments.data.futures.note]} />
              <InstrumentTile title="PAX Gold (PAXG)" tag="tokenised · not spot" tagTone="warning" price={instruments.data.tokenized ? fmtPrice(instruments.data.tokenized.quote.price, ASSET) : "—"} source={instruments.data.tokenized?.quote.source ?? null} lines={[instruments.data.tokenized?.kind ?? "PAXG quote unavailable", instruments.data.tokenized?.premiumVsSpotPct !== null && instruments.data.tokenized?.premiumVsSpotPct !== undefined ? `Premium vs spot ${fmtPct(instruments.data.tokenized.premiumVsSpotPct, 2)} — trades 24/7 on crypto venues, so it drifts from spot while spot is closed.` : ""]} />
            </div>
          )}
        </Card>
        <Card title="Price verification" subtitle="Independent sources compared every minute — the price is only called verified when they agree" loading={verification.isLoading} error={verification.isError ? (verification.error as Error).message : null} onRetry={() => verification.refetch()} actions={verification.data && <Badge tone={verification.data.spot.status === "verified" ? "bull" : verification.data.spot.status === "divergent" ? "bear" : "warning"}>spot {verification.data.spot.status}</Badge>}>
          {verification.data && <VerificationPanel v={verification.data} tz={tz} />}
        </Card>
      </div>

      <div className="grid xl:grid-cols-[minmax(0,1fr)_380px] gap-4">
        <div className="space-y-4 min-w-0">
          <Card title={`XAU/USD · ${tf}`} subtitle="Previous day/week and session levels are drawn as gold dotted lines; S/R in green/red." padded={false} source={candles.data?.source}>
            {candles.isLoading ? <div className="skeleton h-[640px] m-4" /> : candles.isError ? <ErrorState message={(candles.error as Error).message} retry={() => candles.refetch()} /> : candles.data ? <PriceChart assetId={ASSET} timeframe={tf} candles={candles.data.candles} overlays={overlays} levels={levels} height={400} /> : null}
          </Card>

          <div className="grid lg:grid-cols-2 gap-4">
            <Card title="Session ranges" subtitle="Asia 00:00–08:00 UTC · London 08:00–16:30 local · New York 08:00–17:00 local (DST-aware)" loading={analysis.isLoading} padded={false}>
              {a?.sessions && (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-ink-3 text-left">
                      <th className="px-4 py-2 font-medium">Session</th>
                      <th className="px-2 py-2 font-medium text-right">High</th>
                      <th className="px-2 py-2 font-medium text-right">Low</th>
                      <th className="px-2 py-2 font-medium text-right">Range</th>
                      <th className="px-4 py-2 font-medium text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...a.sessions.today.map((s) => ({ ...s, day: "Today" })), ...a.sessions.previous.map((s) => ({ ...s, day: "Yesterday" }))].map((s, i) => (
                      <tr key={i} className="border-t border-line">
                        <td className="px-4 py-1.5 text-ink-1">
                          {s.name} <span className="text-ink-3">· {s.day}</span>
                        </td>
                        <td className="px-2 py-1.5 tabular text-right">{s.high !== null ? fmtPrice(s.high, ASSET) : "—"}</td>
                        <td className="px-2 py-1.5 tabular text-right">{s.low !== null ? fmtPrice(s.low, ASSET) : "—"}</td>
                        <td className="px-2 py-1.5 tabular text-right text-ink-2">{s.high !== null && s.low !== null ? `${fmtNum(s.high - s.low, 2)}${atr1h ? ` (${fmtNum((s.high - s.low) / atr1h, 1)} ATR)` : ""}` : "—"}</td>
                        <td className="px-4 py-1.5 text-right">{s.inProgress ? <Badge tone="accent" size="sm">in progress</Badge> : s.bars ? <span className="text-ink-3">{s.bars} bars</span> : <span className="text-ink-3">no data</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title="Previous day / week levels" subtitle="Completed UTC periods from 1h candles" loading={analysis.isLoading}>
              {a?.periodLevels && (
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {[
                    ["Prev day high", a.periodLevels.prevDayHigh],
                    ["Prev day low", a.periodLevels.prevDayLow],
                    ["Prev day close", a.periodLevels.prevDayClose],
                    ["Today high", a.periodLevels.todayHigh],
                    ["Prev week high", a.periodLevels.prevWeekHigh],
                    ["Prev week low", a.periodLevels.prevWeekLow],
                    ["Today low", a.periodLevels.todayLow],
                  ].map(([k, v]) => (
                    <div key={String(k)} className="card p-2.5">
                      <div className="text-ink-3">{String(k)}</div>
                      <div className="tabular font-medium text-ink-1">{typeof v === "number" ? fmtPrice(v, ASSET) : "—"}</div>
                      <div className="text-[10.5px] text-ink-3">{typeof v === "number" && a.price ? fmtPct(((v - a.price) / a.price) * 100) : ""}</div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <Card title="Multi-timeframe read" loading={analysis.isLoading} error={analysis.isError ? (analysis.error as Error).message : null} onRetry={() => analysis.refetch()}>
            {a && (
              <div className="space-y-3">
                <MtfMatrix perTimeframe={a.mtf.perTimeframe} selected={tf} onSelect={(t) => setTf(t)} />
                <ul className="space-y-1 text-sm text-ink-2">
                  {a.mtfExplanation.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          <div className="grid lg:grid-cols-2 gap-4">
            <Card title="Intraday structure" subtitle={`${detail?.timeframe ?? tf} swings and breakouts`} loading={analysis.isLoading}>
              {detail?.structure && <StructurePanel structure={detail.structure} assetId={ASSET} price={a?.price ?? 0} />}
            </Card>
            <Card title="Support, resistance & liquidity" loading={analysis.isLoading} padded={false}>
              {detail && <LevelsTable support={detail.support} resistance={detail.resistance} liquidity={a?.liquidity ?? []} assetId={ASSET} price={a?.price ?? 0} />}
            </Card>
          </div>
        </div>

        <div className="space-y-4 min-w-0">
          <Card title="Gold macro-technical posture" subtitle="Dollar leg uses the measured 60-day correlation — no inverse assumption" source={posture.data?.sources} loading={posture.isLoading} error={posture.isError ? (posture.error as Error).message : null} onRetry={() => posture.refetch()} actions={<Button size="sm" variant="ghost" icon={<Sparkles className="h-3.5 w-3.5" />} loading={narrative.isPending} onClick={() => narrative.mutate({ kind: "regime", market: "gold" })}>Explain</Button>}>
            {posture.data && (
              <div className="space-y-3">
                <RegimeMeter score={posture.data.result.score} zone={posture.data.result.zone} components={posture.data.result.components} effectiveWeights={posture.data.result.effectiveWeights} />
                {posture.data.notes.map((n, i) => (
                  <p key={i} className="text-[11px] text-ink-3">• {n}</p>
                ))}
                {narrative.data && <NarrativeBlock narrative={narrative.data.narrative} compact />}
              </div>
            )}
          </Card>
          <Card title="US Dollar Index" subtitle="ICE formula on the six constituent rates" source={dxy.data?.source} loading={dxy.isLoading} error={dxy.isError ? (dxy.error as Error).message : null} onRetry={() => dxy.refetch()}>
            {dxy.data && (
              <div className="space-y-2 text-xs">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <div className="text-2xl font-semibold tabular text-ink-1">{Number.isFinite(dxy.data.value) ? fmtNum(dxy.data.value, 3) : "—"}</div>
                    <div className="text-[10.5px] text-ink-3">as of {fmtDateTime(dxy.data.ts, tz)}</div>
                  </div>
                  {dxy.data.history1d.length > 5 && <Sparkline values={dxy.data.history1d.slice(-120).map((p) => p.value)} tone="muted" width={120} height={32} />}
                </div>
                {dxy.data.archiveLastClose && (
                  <p className="text-ink-2">
                    Archive last close <span className="tabular text-ink-1">{fmtNum(dxy.data.archiveLastClose.value, 3)}</span> ({fmtDateTime(dxy.data.archiveLastClose.time, tz)}) · live vs archive{" "}
                    <span className={cls("tabular", Math.abs(dxy.data.computedVsArchivePct ?? 0) > 0.3 ? "text-warn" : "text-ink-1")}>{dxy.data.computedVsArchivePct !== null ? fmtPct(dxy.data.computedVsArchivePct, 3) : "—"}</span>
                  </p>
                )}
                {dxy.data.components && (
                  <div className="grid grid-cols-3 gap-1">
                    {Object.entries(dxy.data.components).map(([k, v]) => (
                      <div key={k} className="card px-2 py-1">
                        <div className="text-[10.5px] text-ink-3">{k.slice(0, 3)}/{k.slice(3)}</div>
                        <div className="tabular text-ink-1">{fmtNum(v, k === "USDJPY" ? 3 : 5)}</div>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[10.5px] text-ink-3">{dxy.data.history1d.length} daily and {dxy.data.history1h.length} hourly points from the archive. Weights: EUR 57.6% · JPY 13.6% · GBP 11.9% · CAD 9.1% · SEK 4.2% · CHF 3.6%.</p>
              </div>
            )}
          </Card>
          <Card title="Macro backdrop" subtitle="Verified series · daily" loading={macro.isLoading}>
            {macro.data && (
              <div className="space-y-2">
                <MacroRow s={macro.data.dxy} unitDigits={2} invertTone />
                <MacroRow s={macro.data.dgs10} unitDigits={2} invertTone />
                <MacroRow s={macro.data.dgs2} unitDigits={2} invertTone />
                <MacroRow s={macro.data.real10} unitDigits={2} invertTone highlight />
                <MacroRow s={macro.data.curve} unitDigits={2} />
                {macro.data.errors.map((e, i) => (
                  <p key={i} className="text-[11px] text-warn">{e}</p>
                ))}
                <p className="text-[10.5px] text-ink-3">Rising real yields raise gold's opportunity cost; the relationship with the dollar is measured, not assumed (see posture component).</p>
              </div>
            )}
          </Card>
          <Card title={`Indicators · ${detail?.timeframe ?? tf}`} source={detail?.source} loading={analysis.isLoading}>
            {detail?.indicators && <IndicatorPanel ind={detail.indicators} assetId={ASSET} />}
          </Card>
          <Card title="Scheduled macro risk" subtitle={`Next 14 days · ${tz}`} loading={cal.isLoading}>
            {cal.data && (
              <ul className="space-y-2">
                {cal.data.events.slice(0, 8).map((e) => (
                  <li key={e.id} className="text-xs">
                    <div className="flex items-start gap-2">
                      <span className="tabular text-ink-3 w-24 shrink-0">{fmtDateTime(e.time, tz)}</span>
                      <span className="text-ink-1 flex-1">{e.title}</span>
                      <Badge tone={e.importance === "high" ? "bear" : "warning"} size="sm">{e.importance}</Badge>
                    </div>
                    <div className="pl-26 ml-[104px] text-[10.5px] text-ink-3 flex gap-2">
                      <span>{fmtUntil(e.time)}</span>
                      {e.forecast && <span>fcst {e.forecast}</span>}
                      {e.previous && <span>prev {e.previous}</span>}
                      {e.official && <span className="text-accent">official</span>}
                    </div>
                  </li>
                ))}
                {cal.data.events.length === 0 && <p className="text-xs text-ink-3">No gold-relevant releases in the window.</p>}
              </ul>
            )}
          </Card>
          <Card title="Fed & geopolitics" subtitle="Headlines tagged by rule; interpretation is yours" loading={intel.isLoading}>
            {intel.data && (
              <ul className="space-y-2">
                {[...intel.data.gold.fed.slice(0, 4), ...intel.data.gold.geopolitics.slice(0, 4)].map((n) => (
                  <li key={n.id}>
                    <a href={n.link} target="_blank" rel="noreferrer noopener" className="text-sm text-ink-1 hover:text-accent leading-snug">{n.title}</a>
                    <div className="text-[10.5px] text-ink-3">{n.publisher} · {fmtAge(n.publishedAt)} · {n.relevance.join(", ")}</div>
                  </li>
                ))}
              </ul>
            )}
            {intel.data && <p className="text-[10.5px] text-ink-3 mt-3">{intel.data.gold.positioning.note}</p>}
          </Card>
          <Disclaimer />
        </div>
      </div>
    </div>
  );
}

function InstrumentTile({ title, tag, tagTone, price, source, lines }: { title: string; tag: string; tagTone: Tone; price: string; source: DataSource | null; lines: string[] }) {
  return (
    <div className="card p-3 space-y-1.5 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-ink-1">{title}</span>
        <Badge tone={tagTone} size="sm">
          {tag}
        </Badge>
      </div>
      <div className="text-lg font-semibold tabular text-ink-1">{price}</div>
      {source && <SourceBadge source={source} compact />}
      {lines
        .filter(Boolean)
        .map((l, i) => (
          <p key={i} className="text-[11px] text-ink-3 leading-snug">
            {l}
          </p>
        ))}
    </div>
  );
}

function VerificationPanel({ v, tz }: { v: GoldVerification; tz: string }) {
  const spotRows = [
    { name: "Swissquote · live BBO mid", price: v.spot.swissquote?.price, ts: v.spot.swissquote?.ts },
    { name: "gold-api.com · independent feed", price: v.spot.goldApi?.price, ts: v.spot.goldApi?.ts },
    { name: "Dukascopy archive · last hourly close", price: v.spot.dukascopyLastClose?.price, ts: v.spot.dukascopyLastClose?.ts },
    { name: "Twelve Data", price: v.spot.twelveData?.price, ts: v.spot.twelveData?.ts },
  ];
  const present = spotRows.filter((r) => typeof r.price === "number");
  const mean = present.length ? present.reduce((a, r) => a + (r.price as number), 0) / present.length : null;
  const dxyRows = [
    { name: "Live · ICE formula on Swissquote FX", value: v.dxy.live?.value, ts: v.dxy.live?.ts },
    { name: "Dukascopy archive · last hourly close", value: v.dxy.archiveLastClose?.value, ts: v.dxy.archiveLastClose?.ts },
    { name: `ECB fixings (daily reference) · ${v.dxy.syntheticEcb?.date ?? "—"}`, value: v.dxy.syntheticEcb?.value, ts: undefined },
  ];
  const tone = (s: GoldVerification["spot"]["status"]): Tone => (s === "verified" ? "bull" : s === "divergent" ? "bear" : "warning");
  return (
    <div className="space-y-3 text-xs">
      <table className="w-full">
        <thead>
          <tr className="text-ink-3 text-left">
            <th className="py-1 font-medium">Spot XAU/USD source</th>
            <th className="py-1 font-medium text-right">Price</th>
            <th className="py-1 font-medium text-right">As of</th>
            <th className="py-1 font-medium text-right">vs mean</th>
          </tr>
        </thead>
        <tbody>
          {spotRows.map((r) => (
            <tr key={r.name} className="border-t border-line">
              <td className="py-1 text-ink-2">{r.name}</td>
              <td className="py-1 tabular text-right text-ink-1">{typeof r.price === "number" ? fmtPrice(r.price, "XAUUSD") : <span className="text-ink-3">unavailable</span>}</td>
              <td className="py-1 tabular text-right text-ink-3">{r.ts ? fmtDateTime(r.ts, tz) : "—"}</td>
              <td className={cls("py-1 tabular text-right", typeof r.price === "number" && mean && Math.abs(((r.price - mean) / mean) * 100) > 0.25 ? "text-warn" : "text-ink-2")}>{typeof r.price === "number" && mean ? fmtPct(((r.price - mean) / mean) * 100, 3) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-ink-3">
        Max spread between sources <span className="tabular text-ink-1">{v.spot.maxDeviationPct !== null ? `${v.spot.maxDeviationPct.toFixed(3)}%` : "—"}</span> · {present.length} source{present.length === 1 ? "" : "s"} · {v.marketOpen ? "market open" : "market closed"} · checked {fmtAge(v.checkedAt)}
      </p>
      <div className="flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-ink-3">US Dollar Index</span>
        <Badge tone={tone(v.dxy.status)} size="sm">
          {v.dxy.status}
        </Badge>
        {v.dxy.maxDeviationPct !== null && <span className="text-ink-3">live vs archive {v.dxy.maxDeviationPct.toFixed(3)}%</span>}
      </div>
      <table className="w-full">
        <tbody>
          {dxyRows.map((r) => (
            <tr key={r.name} className="border-t border-line">
              <td className="py-1 text-ink-2">{r.name}</td>
              <td className="py-1 tabular text-right text-ink-1">{typeof r.value === "number" ? fmtNum(r.value, 3) : <span className="text-ink-3">unavailable</span>}</td>
              <td className="py-1 tabular text-right text-ink-3">{r.ts ? fmtDateTime(r.ts, tz) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {v.notes.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-ink-3">
          {v.notes.map((n, i) => (
            <li key={i}>• {n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MacroRow({ s, unitDigits, invertTone, highlight }: { s: MacroSeries | null; unitDigits: number; invertTone?: boolean; highlight?: boolean }) {
  if (!s) return null;
  const chg = s.change20d;
  const tone = chg === null ? "neutral" : (invertTone ? chg < 0 : chg > 0) ? "bull" : "bear";
  return (
    <div className={cls("flex items-center gap-3 py-1.5 border-b border-line last:border-0", highlight && "bg-gold-soft -mx-2 px-2 rounded")}>
      <div className="min-w-0 flex-1">
        <Tooltip content={<span>{s.source.label}{s.source.note ? ` — ${s.source.note}` : ""}</span>}>
          <span className="text-xs text-ink-2 truncate cursor-help">{s.label}</span>
        </Tooltip>
        <div className="text-[10.5px] text-ink-3">as of {s.points[s.points.length - 1]?.date} {s.source.proxy && <span className="text-gold">· synthetic</span>}</div>
      </div>
      <Sparkline values={s.points.slice(-60).map((p) => p.value)} tone="muted" width={72} height={22} />
      <div className="text-right">
        <div className="tabular text-sm font-medium text-ink-1">{fmtNum(s.latest, unitDigits)}{s.unit === "%" ? "%" : ""}</div>
        <div className={cls("tabular text-[10.5px]", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-ink-3")}>{chg !== null ? `${fmtSigned(chg, unitDigits)} / 20d` : ""}</div>
      </div>
    </div>
  );
}

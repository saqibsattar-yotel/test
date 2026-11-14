import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarClock, Newspaper, Star } from "lucide-react";
import { assetBase, type AssetId, type Timeframe } from "@terminal/core";
import { AssetPicker } from "@/components/ui/AssetPicker";
import { useAssetLabel } from "@/lib/assets";
import { Badge, Card, DataNotice, Disclaimer, EmptyState, ErrorState, Meter, PageHeader, Segmented, SkeletonBlock, SourceBadge, Sparkline, Stat, Tooltip } from "@/components/ui";
import { PriceChart, DEFAULT_OVERLAYS } from "@/components/charts/PriceChart";
import { zoneTone } from "@/components/charts/RegimeMeter";
import { NarrativeBlock } from "@/components/setups/NarrativeBlock";
import { useCandles, useOverview, useSettings, useUpdateWatchlist, useWatchlist } from "@/lib/queries";
import { useUi, useUiNoQuotes } from "@/lib/store";
import { cls, fmtAge, fmtCompact, fmtDateTime, fmtPct, fmtPrice, fmtUntil, toneForChange } from "@/lib/format";
import { assetTextClass, isMetalAsset, workspacePath } from "@/lib/metals";

/**
 * Headline tiles: two per row on a phone (Bitcoin full width), a crypto row and a metals row on a
 * laptop, all five in one row on a wide screen.
 */
const HEADLINE: { assetId: AssetId; span: string }[] = [
  { assetId: "BTCUSD", span: "col-span-2 lg:col-span-2 2xl:col-span-1" },
  { assetId: "ETHUSD", span: "lg:col-span-2 2xl:col-span-1" },
  { assetId: "SOLUSD", span: "lg:col-span-2 2xl:col-span-1" },
  { assetId: "XAUUSD", span: "lg:col-span-3 2xl:col-span-1" },
  { assetId: "XAGUSD", span: "lg:col-span-3 2xl:col-span-1" },
];
const POSTURE_HINT = "5-component macro-technical composite (trend, dollar, real yields, momentum, volatility). The dollar leg measures the live correlation instead of assuming an inverse.";

const TFS: Timeframe[] = ["15m", "1h", "4h", "1d"];

export default function Overview() {
  const ov = useOverview();
  const ui = useUiNoQuotes();
  const L = useAssetLabel();
  const settings = useSettings();
  const layout = settings.data?.settings.dashboardLayout;
  const show = (id: string) => !layout || layout.length === 0 || layout.includes(id);
  const navigate = useNavigate();
  const [tf, setTf] = useState<Timeframe>(ui.selectedTimeframe);
  const asset = ui.selectedAsset;
  const candles = useCandles(asset, tf, 400);
  const d = ov.data;
  const tz = ui.timezone;
  const regimeC = d?.regime.crypto;
  const regimeG = d?.regime.gold;
  const regimeS = d?.regime.silver;
  const fng = d?.fearGreed && !("error" in d.fearGreed) ? d.fearGreed : null;
  const global = d?.global && !("error" in d.global) ? d.global : null;
  const avgF = d?.funding?.avg8h ?? null;

  return (
    <div className="space-y-4">
      <PageHeader title="Overview" description="Live market state across crypto, gold and silver with the regime read, scheduled risk and the day's briefing. Every panel names its data source." actions={<span className="text-xs text-ink-3">{d ? `Refreshed ${fmtAge(d.generatedAt)}` : ""}</span>} />

      {show("tickers") && <div className="grid grid-cols-2 lg:grid-cols-6 2xl:grid-cols-5 gap-3">
        {HEADLINE.map(({ assetId, span }) => (
          <QuoteTile key={assetId} assetId={assetId} onClick={() => ui.setSelectedAsset(assetId)} active={asset === assetId} className={span} />
        ))}
      </div>}

      {show("regime") && <div className="grid grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7 gap-3">
        <Stat label="Crypto regime" hint="6-component composite (BTC trend, alt breadth, dominance, funding, drawdown/vol, momentum). 0–39 risk-off, 40–79 neutral, 80+ risk-on. Descriptive, not predictive." value={regimeC ? (regimeC.score === null ? "UNKNOWN" : regimeC.score.toFixed(0)) : ov.isLoading ? "…" : "—"} delta={regimeC?.zone.replace("_", " ")} deltaTone={regimeC ? zoneTone(regimeC.zone) : "muted"} sub={<Meter value={regimeC?.score ?? null} tone={regimeC ? zoneTone(regimeC.zone) : "muted"} className="mt-1" />} />
        <Stat label="Gold posture" hint={POSTURE_HINT} value={regimeG ? (regimeG.score === null ? "UNKNOWN" : regimeG.score.toFixed(0)) : ov.isLoading ? "…" : "—"} delta={regimeG?.zone} deltaTone={regimeG ? zoneTone(regimeG.zone) : "muted"} sub={<Meter value={regimeG?.score ?? null} tone={regimeG ? zoneTone(regimeG.zone) : "muted"} className="mt-1" />} />
        <Stat label="Silver posture" hint={`${POSTURE_HINT} Same method as gold, on silver's own prices.`} value={regimeS ? (regimeS.score === null ? "UNKNOWN" : regimeS.score.toFixed(0)) : ov.isLoading ? "…" : "—"} delta={regimeS?.zone} deltaTone={regimeS ? zoneTone(regimeS.zone) : "muted"} sub={<Meter value={regimeS?.score ?? null} tone={regimeS ? zoneTone(regimeS.zone) : "muted"} className="mt-1" />} />
        <Stat label="Fear & Greed" hint="alternative.me crypto sentiment composite, updated daily." value={fng ? fng.value : "—"} delta={fng?.classification} deltaTone={fng ? (fng.value <= 25 ? "bear" : fng.value >= 75 ? "bull" : "neutral") : "muted"} sub={fng ? <Sparkline values={fng.history.map((h) => h.value)} tone="muted" width={120} height={22} /> : undefined}>
          {fng && <SourceBadge source={fng.source} compact />}
        </Stat>
        <Stat className="col-span-2 2xl:col-span-1" label="Total crypto market cap" value={global ? `$${fmtCompact(global.totalMarketCapUsd, 2)}` : "—"} delta={global ? fmtPct(global.marketCapChange24hPct) : undefined} deltaTone={toneForChange(global?.marketCapChange24hPct)} sub={global ? `24h volume $${fmtCompact(global.totalVolume24hUsd, 1)}` : undefined}>
          {global && <SourceBadge source={global.source} compact />}
        </Stat>
        <Stat label="BTC dominance" value={global ? `${global.btcDominancePct.toFixed(1)}%` : "—"} sub={global ? `ETH ${global.ethDominancePct.toFixed(1)}%` : undefined} hint="Bitcoin's share of total crypto market capitalisation (CoinGecko)." />
        <Stat label="Avg perp funding (8h)" hint="Average latest funding rate across tracked USDT perpetuals. Positive = longs pay shorts." value={avgF !== null ? `${(avgF * 100).toFixed(4)}%` : "—"} delta={avgF !== null ? `${(avgF * 3 * 365 * 100).toFixed(1)}% ann.` : undefined} deltaTone={avgF !== null ? (avgF > 0.0003 ? "bear" : avgF < 0 ? "bull" : "neutral") : "muted"} sub={d?.volatility.btcAtrPct1d ? <span className="block whitespace-normal" title={`Daily ATR as a share of price: BTC ${d.volatility.btcAtrPct1d.toFixed(2)}%, gold ${d.volatility.goldAtrPct1d?.toFixed(2) ?? "—"}%, silver ${d.volatility.silverAtrPct1d?.toFixed(2) ?? "—"}%`}>1d ATR · BTC {d.volatility.btcAtrPct1d.toFixed(1)}% · XAU {d.volatility.goldAtrPct1d?.toFixed(1) ?? "—"}% · XAG {d.volatility.silverAtrPct1d?.toFixed(1) ?? "—"}%</span> : undefined}>
          {d?.funding?.source && <SourceBadge source={d.funding.source} compact />}
        </Stat>
      </div>}

      <div className="grid xl:grid-cols-[minmax(0,1fr)_360px] gap-4">
        <div className="space-y-4 min-w-0">
          {show("chart") && <Card
            title={`${L(asset).symbol} · interactive chart`}
            subtitle="Scroll to zoom, drag to pan. EMA 20/50/200 shown; RSI and MACD below."
            padded={false}
            source={candles.data?.source}
            actions={
              <Segmented
                size="sm"
                options={TFS.map((t) => ({ value: t, label: t }))}
                value={tf}
                onChange={(t) => {
                  setTf(t);
                  ui.setSelectedTimeframe(t);
                }}
              />
            }
          >
            <div className="px-4 pt-3">
              <Segmented size="sm" options={Array.from(new Set([...HEADLINE.map((h) => h.assetId), asset])).map((a) => ({ value: a, label: assetBase(a) }))} value={asset} onChange={(a) => ui.setSelectedAsset(a)} />
            </div>
            {candles.data && <DataNotice sources={[candles.data.source]} warnings={candles.data.warnings} className="px-4 pt-3" />}
            {candles.isLoading ? <div className="skeleton h-[560px] m-4" /> : candles.isError ? <ErrorState message={(candles.error as Error).message} retry={() => candles.refetch()} /> : candles.data ? <PriceChart assetId={asset} timeframe={tf} candles={candles.data.candles} overlays={{ ...DEFAULT_OVERLAYS, levels: false }} height={360} /> : null}
          </Card>}

          {show("conditions") && <div className="grid md:grid-cols-2 gap-4">
            <Card title="Bullish conditions" subtitle="Regime components scoring ≥ 60">{ov.isLoading ? <SkeletonBlock /> : d?.conditions.bullish.length ? <ConditionList items={d.conditions.bullish} tone="bull" /> : <EmptyState compact title="No strongly bullish components" />}</Card>
            <Card title="Bearish conditions" subtitle="Regime components scoring ≤ 40">{ov.isLoading ? <SkeletonBlock /> : d?.conditions.bearish.length ? <ConditionList items={d.conditions.bearish} tone="bear" /> : <EmptyState compact title="No strongly bearish components" />}</Card>
          </div>}

          {show("briefing") && <Card title="Daily market briefing" subtitle="Generated from verified numbers only; labelled rule-based when no model key is configured.">
            {ov.isLoading ? <SkeletonBlock lines={5} /> : ov.isError ? <ErrorState message={(ov.error as Error).message} retry={() => ov.refetch()} /> : d ? <NarrativeBlock narrative={d.briefing} /> : null}
          </Card>}
        </div>

        <div className="space-y-4 min-w-0">
          {show("watchlist") && <Watchlist />}
          {show("events") && <Card
            title="Upcoming high-impact events"
            subtitle={`Times in ${tz}`}
            actions={
              <button className="text-xs text-accent hover:underline" onClick={() => navigate("/intelligence?tab=calendar")}>
                Calendar →
              </button>
            }
          >
            {ov.isLoading ? (
              <SkeletonBlock lines={5} />
            ) : d?.upcomingEvents.length ? (
              <ul className="space-y-2.5">
                {d.upcomingEvents.slice(0, 6).map((e) => (
                  <li key={e.id} className="flex items-start gap-3">
                    <div className="shrink-0 w-16 text-right">
                      <div className="text-xs font-medium text-ink-1 tabular">{fmtDateTime(e.time, tz).slice(-5)}</div>
                      <div className="text-[10.5px] text-ink-3">{fmtDateTime(e.time, tz).slice(0, 6)}</div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-ink-1 leading-snug">{e.title}</div>
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <Badge tone={e.importance === "high" ? "bear" : e.importance === "medium" ? "warning" : "muted"} size="sm">
                          {e.importance}
                        </Badge>
                        <span className="text-[10.5px] text-ink-3">{e.country}</span>
                        {e.official && (
                          <Badge tone="accent" size="sm">
                            official schedule
                          </Badge>
                        )}
                        <span className="text-[10.5px] text-ink-3 ml-auto">{fmtUntil(e.time)}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact icon={<CalendarClock className="h-5 w-5" />} title="No high-impact events in the next 10 days" />
            )}
          </Card>}
          {show("news") && <Card
            title="Latest market news"
            subtitle="Publisher RSS feeds · newest first"
            actions={
              <button className="text-xs text-accent hover:underline" onClick={() => navigate("/intelligence?tab=news")}>
                All news →
              </button>
            }
          >
            {ov.isLoading ? (
              <SkeletonBlock lines={6} />
            ) : d?.news.length ? (
              <ul className="space-y-2.5">
                {d.news.slice(0, 8).map((n) => (
                  <li key={n.id}>
                    <a href={n.link} target="_blank" rel="noreferrer noopener" className="text-sm text-ink-1 hover:text-accent leading-snug block">
                      {n.title}
                    </a>
                    <div className="text-[10.5px] text-ink-3 mt-0.5">
                      {n.publisher} · {fmtAge(n.publishedAt)}
                      {n.relevance.includes("gold") && <span className="text-gold"> · gold</span>}
                      {n.relevance.includes("silver") && <span className="text-silver"> · silver</span>}
                      {n.relevance.includes("btc") && <span className="text-accent"> · BTC</span>}
                      {n.relevance.includes("fed") && <span className="text-warn"> · Fed</span>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact icon={<Newspaper className="h-5 w-5" />} title="No news loaded" />
            )}
          </Card>}
          <Disclaimer />
        </div>
      </div>
    </div>
  );
}

function ConditionList({ items, tone }: { items: string[]; tone: "bull" | "bear" }) {
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => {
        const [head, ...rest] = it.split(": ");
        return (
          <li key={i} className="flex items-start gap-2 text-xs">
            <span className={cls("mt-1.5 h-1.5 w-1.5 rounded-full shrink-0", tone === "bull" ? "bg-bull" : "bg-bear")} />
            <span className="text-ink-2">
              <span className="text-ink-1 font-medium">{head}: </span>
              {rest.join(": ")}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function QuoteTile({ assetId, onClick, active, className }: { assetId: AssetId; onClick?: () => void; active?: boolean; className?: string }) {
  const q = useUi((s) => s.quotes[assetId]);
  const L = useAssetLabel();
  const spark = useCandles(assetId, "1h", 48);
  const tone = toneForChange(q?.changePct24h);
  const metal = isMetalAsset(assetId);
  return (
    <button onClick={onClick} className={cls("card text-left px-4 py-3.5 min-w-0 transition-colors hover:bg-surface-2", active && "ring-1 ring-accent", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className={cls("text-xs font-semibold", assetTextClass(assetId, "text-ink-2"))}>{L(assetId).symbol}</span>
        {q ? <SourceBadge source={q.source} compact /> : <span className="skeleton h-4 w-16" />}
      </div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="text-lg sm:text-xl font-semibold text-ink-1 tabular truncate">{q ? fmtPrice(q.price, assetId) : "—"}</div>
          <div className={cls("text-xs tabular font-medium", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-ink-3")}>
            {/* The change is null when its reference price is not known (a metal whose previous close could not be loaded). */}
            {q && q.change24h !== null && q.changePct24h !== null ? `${fmtPct(q.changePct24h)} · ${q.change24h >= 0 ? "+" : ""}${fmtPrice(q.change24h, assetId)}` : ""}
            <span className="text-ink-3 font-normal"> {q && q.change24h === null ? "change unavailable" : metal ? "vs prev close" : "24h"}</span>
          </div>
        </div>
        {spark.data ? <Sparkline values={spark.data.candles.map((c) => c.close)} tone="auto" width={88} height={30} className="hidden sm:block shrink-0" /> : <span className="skeleton h-7 w-20 hidden sm:block" />}
      </div>
    </button>
  );
}

function Watchlist() {
  const wl = useWatchlist();
  const wlm = useUpdateWatchlist();
  const quotes = useUi((s) => s.quotes);
  const navigate = useNavigate();
  const setCrypto = useUi((s) => s.setSelectedCrypto);
  const setSelected = useUi((s) => s.setSelectedAsset);
  const list = wl.data?.watchlist ?? [];
  const favs = wl.data?.favorites ?? [];
  const [adding, setAdding] = useState(false);
  const L = useAssetLabel();
  return (
    <Card
      title="Watchlist"
      subtitle="Live prices · star to favourite"
      actions={
        <button className="text-xs text-accent hover:underline" onClick={() => setAdding(!adding)}>
          {adding ? "Done" : "Edit"}
        </button>
      }
      padded={false}
    >
      {wl.isLoading ? (
        <div className="p-4">
          <SkeletonBlock lines={5} />
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {[...list]
            .sort((a, b) => Number(favs.includes(b)) - Number(favs.includes(a)))
            .map((a) => {
              const q = quotes[a];
              const tone = toneForChange(q?.changePct24h);
              return (
                <li key={a} className="flex items-center gap-2 px-4 py-2">
                  <button aria-label={favs.includes(a) ? "Unfavourite" : "Favourite"} className={cls("shrink-0", favs.includes(a) ? "text-gold" : "text-ink-3 hover:text-gold")} onClick={() => wlm.mutate({ favorites: favs.includes(a) ? favs.filter((x) => x !== a) : [...favs, a] })}>
                    <Star className="h-3.5 w-3.5" fill={favs.includes(a) ? "currentColor" : "none"} />
                  </button>
                  <button
                    className="flex-1 min-w-0 flex items-center gap-2 text-left"
                    onClick={() => {
                      setSelected(a);
                      if (!isMetalAsset(a)) setCrypto(a);
                      navigate(workspacePath(a));
                    }}
                  >
                    <span className={cls("text-sm font-medium w-14", assetTextClass(a))}>{assetBase(a)}</span>
                    <span className="text-xs text-ink-3 truncate hidden sm:inline">{L(a).name}</span>
                    <span className="ml-auto text-sm tabular text-ink-1">{q ? fmtPrice(q.price, a) : "—"}</span>
                    <span className={cls("w-16 text-right text-xs tabular", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-ink-3")}>{q ? fmtPct(q.changePct24h) : ""}</span>
                  </button>
                  {adding && (
                    <button className="text-xs text-bear hover:underline" onClick={() => wlm.mutate({ watchlist: list.filter((x) => x !== a) })}>
                      remove
                    </button>
                  )}
                </li>
              );
            })}
          {adding && (
            <li className="px-4 py-2">
              <AssetPicker size="sm" placeholder="Add any coin to the watchlist…" exclude={list} onSelect={(id) => wlm.mutate({ watchlist: [...list, id as AssetId] })} />
            </li>
          )}
          {list.length === 0 && (
            <li>
              <EmptyState compact title="Watchlist is empty" description="Use Edit to add assets." />
            </li>
          )}
        </ul>
      )}
      <Tooltip content="Crypto prices stream from Binance; spot XAU/USD and XAG/USD are polled from Swissquote's public quote feed (Twelve Data when a key is configured).">
        <span className="block px-4 py-2 text-[10.5px] text-ink-3 border-t border-line cursor-help">Streaming quotes · hover a source badge for details</span>
      </Tooltip>
    </Card>
  );
}

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronDown, ExternalLink } from "lucide-react";
import type { EconEvent } from "@terminal/core";
import { Badge, Card, DataNotice, Disclaimer, EmptyState, PageHeader, Segmented, SkeletonBlock, SourceBadge, Sparkline, Stat, Tabs, Toggle, Tooltip } from "@/components/ui";
import { LiquidationTimeline } from "@/components/charts/Performance";
import { RegimeMeter } from "@/components/charts/RegimeMeter";
import { useCalendar, useIntel, useNews } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cls, fmtAge, fmtCompact, fmtDate, fmtDateTime, fmtNum, fmtPct, fmtSigned, fmtTime, fmtUntil, fmtWeekday } from "@/lib/format";
import type { MacroSeries } from "@/lib/api";

type Tab = "crypto" | "gold" | "calendar" | "news";

export default function Intelligence() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "crypto";
  const setTab = (t: Tab) => setParams({ tab: t });
  return (
    <div className="space-y-4">
      <PageHeader title="Market Intelligence" description="Crypto positioning and structure, gold macro drivers, the economic calendar and news — each with a plain explanation of why it matters. Timestamps and sources on everything." />
      <Tabs tabs={[{ value: "crypto", label: "Crypto" }, { value: "gold", label: "Gold & macro" }, { value: "calendar", label: "Economic calendar" }, { value: "news", label: "News" }]} value={tab} onChange={setTab} />
      {tab === "crypto" && <CryptoIntel />}
      {tab === "gold" && <GoldIntel />}
      {tab === "calendar" && <Calendar />}
      {tab === "news" && <News />}
      <Disclaimer />
    </div>
  );
}

function Why({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 border-t border-line pt-2">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[11px] text-accent">
        <ChevronDown className={cls("h-3.5 w-3.5 transition-transform", open && "rotate-180")} /> Why it matters
      </button>
      {open && <p className="text-xs text-ink-2 mt-1.5 leading-relaxed">{text}</p>}
    </div>
  );
}

function CryptoIntel() {
  const intel = useIntel();
  const d = intel.data?.crypto;
  if (intel.isLoading) return <SkeletonBlock lines={8} />;
  if (!d) return <EmptyState title="Intelligence unavailable" description={(intel.error as Error)?.message} />;
  const dom = d.dominance && !("error" in d.dominance) ? d.dominance : null;
  const oiBtc = d.openInterest.btc && !("error" in d.openInterest.btc) ? d.openInterest.btc : null;
  const oiEth = d.openInterest.eth && !("error" in d.openInterest.eth) ? d.openInterest.eth : null;
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <Card title="BTC market structure" subtitle="The reserve asset sets the tone for everything else" source={d.btcStructure?.sources}>
        {d.btcStructure ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge tone={d.btcStructure.bias === "bullish" ? "bull" : d.btcStructure.bias === "bearish" ? "bear" : "neutral"} className="capitalize">{d.btcStructure.bias}</Badge>
              <Badge tone="muted">{d.btcStructure.alignment}</Badge>
              <span className="text-xs text-ink-3">support {fmtNum(d.btcStructure.keySupport ?? NaN, 0)} · resistance {fmtNum(d.btcStructure.keyResistance ?? NaN, 0)}</span>
            </div>
            <ul className="text-xs text-ink-2 space-y-1">
              {d.btcStructure.perTimeframe.map((p) => (
                <li key={p.timeframe}><span className="font-semibold text-ink-1">{p.timeframe}</span> {p.bias} · {p.trend} — {p.notes[0]}</li>
              ))}
            </ul>
          </div>
        ) : <p className="text-xs text-ink-3">Unavailable</p>}
        <Why text="Alt regimes rarely stay risk-on while BTC's primary trend is broken; the 4h/daily/weekly structure of BTC is the first filter for any crypto exposure." />
      </Card>
      <Card title="Altcoin market strength" subtitle="Breadth across CoinGecko top-40 (ex-stables)" source={d.altStrength.source}>
        <div className="grid grid-cols-3 gap-2 mb-3">
          <Stat label="Up 24h" value={d.altStrength.breadth24hPct !== null ? `${d.altStrength.breadth24hPct.toFixed(0)}%` : "—"} />
          <Stat label="Up 7d" value={d.altStrength.breadth7dPct !== null ? `${d.altStrength.breadth7dPct.toFixed(0)}%` : "—"} />
          <Stat label="Beat BTC 24h" value={d.altStrength.altsOutperformingBtc24h ?? "—"} />
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <p className="text-ink-3 mb-1">Leaders (24h)</p>
            {d.altStrength.leaders.map((c) => <div key={c.symbol} className="flex justify-between"><span className="text-ink-1">{c.symbol}</span><span className="tabular text-bull">{fmtPct(c.change24hPct)}</span></div>)}
          </div>
          <div>
            <p className="text-ink-3 mb-1">Laggards (24h)</p>
            {d.altStrength.laggards.map((c) => <div key={c.symbol} className="flex justify-between"><span className="text-ink-1">{c.symbol}</span><span className="tabular text-bear">{fmtPct(c.change24hPct)}</span></div>)}
          </div>
        </div>
        <Why text={d.altStrength.why} />
      </Card>
      <Card title="BTC dominance" source={dom?.source}>
        {dom ? (
          <div className="flex items-end gap-6">
            <div><div className="text-3xl font-semibold text-ink-1 tabular">{dom.btcDominancePct.toFixed(1)}%</div><div className="text-xs text-ink-3">BTC share of total cap</div></div>
            <div><div className="text-xl font-semibold text-ink-1 tabular">{dom.ethDominancePct.toFixed(1)}%</div><div className="text-xs text-ink-3">ETH</div></div>
            <div><div className="text-xl font-semibold text-ink-1 tabular">${fmtCompact(dom.totalMarketCapUsd, 2)}</div><div className={cls("text-xs tabular", dom.marketCapChange24hPct >= 0 ? "text-bull" : "text-bear")}>{fmtPct(dom.marketCapChange24hPct)} 24h</div></div>
          </div>
        ) : <p className="text-xs text-ink-3">Unavailable</p>}
        {d.regime && <div className="mt-3"><RegimeMeter score={d.regime.score} zone={d.regime.zone} components={d.regime.components} compact /></div>}
        <Why text="Rising dominance in a BTC uptrend means a BTC-led, narrow market; falling dominance in an uptrend is classic alt rotation. Rising dominance in a downtrend is defensive rotation inside crypto." />
      </Card>
      <Card title="Funding-rate extremes" subtitle="Latest 8h settlement across tracked perps" source={d.funding.source}>
        {d.funding.items.length ? (
          <ul className="space-y-1 text-xs">
            {d.funding.items.map((f) => (
              <li key={f.symbol} className="flex items-center gap-2">
                <span className="w-16 text-ink-1 font-medium">{f.symbol.replace("USDT", "")}</span>
                <span className={cls("tabular w-20", f.fundingRate > 0.0003 ? "text-bear font-semibold" : f.fundingRate < 0 ? "text-bull font-semibold" : "text-ink-2")}>{(f.fundingRate * 100).toFixed(4)}%</span>
                <span className="tabular text-ink-3">{f.annualizedPct.toFixed(1)}% ann.</span>
                {Math.abs(f.fundingRate) >= 0.0003 && <Badge tone={f.fundingRate > 0 ? "bear" : "bull"} size="sm">{f.fundingRate > 0 ? "crowded longs" : "washed out"}</Badge>}
                {f.nextFundingTime && <span className="ml-auto text-ink-3">next {fmtUntil(f.nextFundingTime)}</span>}
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-ink-3">{d.funding.error ?? "Unavailable"}</p>}
        <Why text={d.funding.why} />
      </Card>
      <Card title="Open interest" source={oiBtc?.source}>
        <div className="grid grid-cols-2 gap-3">
          {[oiBtc, oiEth].map((o, i) => o ? (
            <div key={i} className="card p-3">
              <div className="text-xs text-ink-3">{o.symbol}</div>
              <div className="text-lg font-semibold tabular text-ink-1">{fmtCompact(o.openInterestBase, 2)} {o.symbol.replace("USDT", "")}</div>
              <div className={cls("text-xs tabular", (o.change24hPct ?? 0) >= 0 ? "text-bull" : "text-bear")}>{o.change24hPct !== null ? `${fmtPct(o.change24hPct)} / 48h` : ""}{o.openInterestQuote ? ` · $${fmtCompact(o.openInterestQuote, 1)}` : ""}</div>
              <Sparkline values={o.history.map((h) => h.oiQuote)} tone="muted" width={140} height={28} />
              {o.longShortRatio && <div className="text-[10.5px] text-ink-3">global long/short accounts {o.longShortRatio.toFixed(2)}</div>}
            </div>
          ) : <div key={i} className="card p-3 text-xs text-ink-3">Unavailable</div>)}
        </div>
        <Why text={d.openInterest.why} />
      </Card>
      <Card title="Liquidations (24h, since server start)" source={d.liquidations.source}>
        <div className="flex gap-6 mb-3">
          <div><div className="text-xs text-ink-3">Longs liquidated</div><div className="text-lg font-semibold tabular text-bear">${fmtCompact(d.liquidations.totalLongUsd, 1)}</div></div>
          <div><div className="text-xs text-ink-3">Shorts liquidated</div><div className="text-lg font-semibold tabular text-bull">${fmtCompact(d.liquidations.totalShortUsd, 1)}</div></div>
          <div><div className="text-xs text-ink-3">Coverage</div><div className="text-lg font-semibold tabular text-ink-1">{Math.round(d.liquidations.coverageMs / 60000)} min</div></div>
        </div>
        <LiquidationTimeline timeline={d.liquidations.timeline} />
        <Why text={d.liquidations.why} />
      </Card>
      <Card title="Crypto headlines" className="lg:col-span-2">
        <NewsList items={d.news} />
      </Card>
    </div>
  );
}

function MacroCard({ s, title, why, invert }: { s: MacroSeries | null; title: string; why: string; invert?: boolean }) {
  const chg = s?.change20d ?? null;
  const tone = chg === null ? "neutral" : (invert ? chg < 0 : chg > 0) ? "bull" : "bear";
  return (
    <Card title={title} source={s?.source}>
      {s ? (
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-2xl font-semibold tabular text-ink-1">{fmtNum(s.latest, 2)}{s.unit === "%" ? "%" : ""}</div>
            <div className="text-xs text-ink-3">{s.label} · {s.points[s.points.length - 1]?.date}</div>
            <div className={cls("text-xs tabular mt-1", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-ink-3")}>{s.change1d !== null ? `${fmtSigned(s.change1d, 2)} 1d` : ""}{chg !== null ? ` · ${fmtSigned(chg, 2)} 20d` : ""}</div>
          </div>
          <Sparkline values={s.points.slice(-90).map((p) => p.value)} tone="accent" width={150} height={44} />
        </div>
      ) : <p className="text-xs text-ink-3">Unavailable</p>}
      <Why text={why} />
    </Card>
  );
}

function GoldIntel() {
  const intel = useIntel();
  const tz = useUi((s) => s.timezone);
  const g = intel.data?.gold;
  if (intel.isLoading) return <SkeletonBlock lines={8} />;
  if (!g) return <EmptyState title="Intelligence unavailable" description={(intel.error as Error)?.message} />;
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <MacroCard s={g.dollar} title="US dollar" why={g.why.dollar} invert />
      <MacroCard s={g.yields.real10y} title="Real yields (10y TIPS)" why={g.why.yields} invert />
      <MacroCard s={g.yields.tenYear} title="10-year Treasury yield" why="Nominal yields drive the dollar and the discount rate; real yields (above) matter more for gold." invert />
      <MacroCard s={g.yields.curve} title="2s10s curve" why="A steepening curve after inversion has historically coincided with easing cycles — supportive for gold; it is context, not a trigger." />
      {g.yields.errors.length > 0 && <DataNotice warnings={g.yields.errors} className="lg:col-span-2" />}
      <Card title="Scheduled macro releases" subtitle={`Gold/rates-relevant · ${tz}`}>
        {g.macroReleases.length ? (
          <ul className="space-y-2 text-xs">
            {g.macroReleases.map((e) => (
              <li key={e.id} className="flex items-start gap-2">
                <span className="tabular text-ink-3 w-28 shrink-0">{fmtDateTime(e.time, tz)}</span>
                <div className="flex-1">
                  <div className="text-ink-1">{e.title}</div>
                  <div className="text-[10.5px] text-ink-3">{e.country} · {e.importance}{e.forecast ? ` · fcst ${e.forecast}` : ""}{e.previous ? ` · prev ${e.previous}` : ""}{e.official ? " · official schedule" : ""}</div>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-ink-3">No scheduled releases in the window.</p>}
        <Why text={g.why.macro} />
      </Card>
      <Card title="Gold posture" subtitle="Composite with component breakdown">
        {g.posture ? <RegimeMeter score={g.posture.score} zone={g.posture.zone} components={g.posture.components} /> : <p className="text-xs text-ink-3">Unavailable</p>}
      </Card>
      <Card title="Federal Reserve" subtitle="Press releases and Fed-tagged headlines"><NewsList items={g.fed} /></Card>
      <Card title="Geopolitical developments" subtitle="Headlines tagged by keyword rule"><NewsList items={g.geopolitics} /></Card>
      <Card title="Gold demand & positioning" className="lg:col-span-2">
        <EmptyState compact title="Not available without a dedicated provider" description={g.positioning.note} />
      </Card>
      <Card title="Gold headlines" className="lg:col-span-2"><NewsList items={g.goldNews} /></Card>
    </div>
  );
}

function NewsList({ items }: { items: { id: string; title: string; link: string; publishedAt: number; publisher: string; summary: string | null; relevance: string[] }[] }) {
  if (!items.length) return <p className="text-xs text-ink-3">No items.</p>;
  return (
    <ul className="divide-y divide-line -my-1">
      {items.map((n) => (
        <li key={n.id} className="py-2">
          <a href={n.link} target="_blank" rel="noreferrer noopener" className="group flex items-start gap-2">
            <span className="text-sm text-ink-1 group-hover:text-accent leading-snug flex-1">{n.title}</span>
            <ExternalLink className="h-3.5 w-3.5 text-ink-3 mt-1 shrink-0" />
          </a>
          {n.summary && <p className="text-xs text-ink-3 mt-0.5 line-clamp-2">{n.summary}</p>}
          <div className="text-[10.5px] text-ink-3 mt-0.5 flex gap-1.5 flex-wrap">
            <span className="text-ink-2">{n.publisher}</span>
            <span>· {fmtAge(n.publishedAt)}</span>
            {n.relevance.map((r) => <span key={r} className={cls(r === "gold" && "text-gold", r === "btc" && "text-accent", r === "fed" && "text-warn")}>· {r}</span>)}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Calendar() {
  const tz = useUi((s) => s.timezone);
  const [range, setRange] = useState<"today" | "week" | "7" | "30">("7");
  const [market, setMarket] = useState<"all" | "gold" | "crypto">("all");
  const [imp, setImp] = useState<Record<string, boolean>>({ high: true, medium: true, low: false, holiday: false });
  const [now] = useState(() => Date.now());
  const { from, to } = useMemo(() => {
    const day = 86_400_000;
    if (range === "today") return { from: now - 12 * 3600_000, to: now + day };
    if (range === "week") return { from: now - 7 * day, to: now + 7 * day };
    if (range === "7") return { from: now - 2 * 3600_000, to: now + 7 * day };
    return { from: now - 2 * 3600_000, to: now + 30 * day };
  }, [range, now]);
  const cal = useCalendar({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), markets: market === "all" ? undefined : market === "gold" ? "gold,rates,usd" : "btc,eth,crypto" });
  const events = (cal.data?.events ?? []).filter((e) => imp[e.importance]);
  const byDay = useMemo(() => {
    const m = new Map<string, EconEvent[]>();
    for (const e of events) {
      const k = fmtDate(e.time, tz);
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return [...m.entries()];
  }, [events, tz]);
  return (
    <div className="space-y-4">
      <Card padded={false}>
        <div className="p-3 flex flex-col lg:flex-row lg:items-center gap-3">
          <Segmented size="sm" options={[{ value: "today" as const, label: "Today" }, { value: "week" as const, label: "This week ±7d" }, { value: "7" as const, label: "Next 7 days" }, { value: "30" as const, label: "Next 30 days" }]} value={range} onChange={setRange} />
          <Segmented size="sm" options={[{ value: "all" as const, label: "All markets" }, { value: "gold" as const, label: "Gold / USD / rates" }, { value: "crypto" as const, label: "Crypto" }]} value={market} onChange={setMarket} />
          <div className="flex items-center gap-3 lg:ml-auto">
            {(["high", "medium", "low", "holiday"] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5 text-xs text-ink-2 capitalize"><input type="checkbox" checked={imp[k]} onChange={(e) => setImp({ ...imp, [k]: e.target.checked })} className="accent-[var(--accent)]" />{k}</label>
            ))}
            <span className="text-xs text-ink-3">· {tz}</span>
          </div>
        </div>
      </Card>
      {cal.data && <div className="flex flex-wrap gap-2 text-[11px] text-ink-3">{cal.data.sources.map((s) => <Badge key={s.provider} tone={s.error ? "bear" : s.official ? "accent" : "neutral"} size="sm">{s.label}{s.error ? ` — ${s.error}` : ""}</Badge>)}<span>{cal.data.note}</span></div>}
      {cal.isLoading ? <SkeletonBlock lines={8} /> : byDay.length === 0 ? <EmptyState title="No events match" description="Widen the date range or include more importance levels." /> : byDay.map(([day, list]) => (
        <Card key={day} title={day} subtitle={fmtWeekday(list[0].time, tz)} padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-ink-3"><th className="px-4 py-2 font-medium">Time</th><th className="px-2 py-2 font-medium">Event</th><th className="px-2 py-2 font-medium">Ctry</th><th className="px-2 py-2 font-medium">Impact</th><th className="px-2 py-2 font-medium text-right">Previous</th><th className="px-2 py-2 font-medium text-right">Forecast</th><th className="px-2 py-2 font-medium text-right">Actual</th><th className="px-4 py-2 font-medium">Markets</th></tr></thead>
              <tbody>
                {list.map((e) => <CalendarRow key={e.id} e={e} tz={tz} />)}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  );
}

function CalendarRow({ e, tz }: { e: EconEvent; tz: string }) {
  const [open, setOpen] = useState(false);
  const past = e.time < Date.now();
  return (
    <>
      <tr className={cls("border-t border-line cursor-pointer hover:bg-surface-2", past && "opacity-60")} onClick={() => setOpen(!open)}>
        <td className="px-4 py-2 tabular text-ink-1 whitespace-nowrap">{e.allDay ? "all day" : fmtTime(e.time, tz)}</td>
        <td className="px-2 py-2 text-ink-1">{e.title}{e.official && <Badge tone="accent" size="sm" className="ml-1.5">official</Badge>}</td>
        <td className="px-2 py-2 text-ink-2">{e.country}</td>
        <td className="px-2 py-2"><Badge tone={e.importance === "high" ? "bear" : e.importance === "medium" ? "warning" : "muted"} size="sm">{e.importance}</Badge></td>
        <td className="px-2 py-2 tabular text-right text-ink-2">{e.previous ?? "—"}</td>
        <td className="px-2 py-2 tabular text-right text-ink-2">{e.forecast ?? "—"}</td>
        <td className="px-2 py-2 tabular text-right text-ink-1 font-medium">{e.actual ?? (past ? <Tooltip content="Actual values are only shown when supplied by a data provider; they are never estimated."><span className="text-ink-3 cursor-help">n/a</span></Tooltip> : "—")}</td>
        <td className="px-4 py-2"><div className="flex gap-1 flex-wrap">{e.relatedMarkets.map((m) => <span key={m} className={cls("px-1.5 h-5 inline-flex items-center rounded text-[10.5px]", m === "gold" ? "bg-gold-soft text-gold" : m === "btc" || m === "eth" || m === "crypto" ? "bg-accent-soft text-accent" : "bg-surface-3 text-ink-2")}>{m}</span>)}</div></td>
      </tr>
      {open && e.whyItMatters && <tr className="bg-surface-2"><td colSpan={8} className="px-4 py-2 text-xs text-ink-2"><span className="font-medium text-ink-1">Why it matters: </span>{e.whyItMatters} <span className="text-ink-3">· Source: {e.source.label}{e.source.url ? <> · <a className="text-accent" href={e.source.url} target="_blank" rel="noreferrer noopener">link</a></> : null}</span></td></tr>}
    </>
  );
}

function News() {
  const [topic, setTopic] = useState<"all" | "crypto" | "gold" | "macro">("all");
  const [onlyRelevant, setOnlyRelevant] = useState(false);
  const news = useNews(topic, 120);
  const items = (news.data?.items ?? []).filter((n) => !onlyRelevant || n.relevance.some((r) => ["gold", "btc", "eth", "fed"].includes(r)));
  return (
    <div className="space-y-4">
      <Card padded={false}>
        <div className="p-3 flex flex-col sm:flex-row sm:items-center gap-3">
          <Segmented size="sm" options={[{ value: "all" as const, label: "All" }, { value: "crypto" as const, label: "Crypto" }, { value: "gold" as const, label: "Gold" }, { value: "macro" as const, label: "Macro" }]} value={topic} onChange={setTopic} />
          <Toggle checked={onlyRelevant} onChange={setOnlyRelevant} label="Only gold / BTC / Fed tagged" />
          <span className="text-xs text-ink-3 sm:ml-auto">{news.data ? `${items.length} items · fetched ${fmtAge(news.data.fetchedAt)}${news.data.failed.length ? ` · feeds unavailable: ${news.data.failed.join(", ")}` : ""}` : ""}</span>
        </div>
      </Card>
      <Card padded={false}>
        {news.isLoading ? <div className="p-4"><SkeletonBlock lines={10} /></div> : <div className="p-4"><NewsList items={items} /></div>}
      </Card>
      {news.data && <div className="text-[11px] text-ink-3">Feeds: {news.data.feeds.map((f) => f.publisher).join(", ")}. Headlines are the publishers' own; relevance tags are keyword rules.</div>}
    </div>
  );
}

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, BookmarkCheck, Trash2 } from "lucide-react";
import { ASSETS, TIMEFRAMES, isValidTimeZone, type AssetId, type Timeframe } from "@terminal/core";
import { Badge, Button, Card, Disclaimer, Field, Input, PageHeader, Select, Toggle } from "@/components/ui";
import { AssetChip, AssetPicker } from "@/components/ui/AssetPicker";
import { useAssetLabel } from "@/lib/assets";
import { TIMEZONES } from "@/components/layout/Onboarding";
import { StatusBadge } from "@/components/setups/SetupCard";
import { useAlerts, useFeatures, useJournalMutations, useSavedAnalyses, useSavedAnalysisMutations, useSavedSetupMutations, useSavedSetups, useSettings, useUpdateSettings } from "@/lib/queries";
import { useUiNoQuotes } from "@/lib/store";
import { cls, fmtDateTime, fmtPrice, setupTypeLabel } from "@/lib/format";
import { METALS, METAL_SELECTED, isMetalAsset } from "@/lib/metals";

export const WIDGETS: { id: string; label: string }[] = [
  { id: "tickers", label: "Headline quote tiles" },
  { id: "chart", label: "Interactive chart" },
  { id: "regime", label: "Market state row (regime, sentiment, cap, funding)" },
  { id: "conditions", label: "Bullish / bearish conditions" },
  { id: "briefing", label: "Daily AI briefing" },
  { id: "watchlist", label: "Watchlist" },
  { id: "events", label: "Upcoming events" },
  { id: "news", label: "Latest news" },
];

export default function Settings() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const features = useFeatures();
  const ui = useUiNoQuotes();
  const navigate = useNavigate();
  const alerts = useAlerts();
  const savedSetups = useSavedSetups();
  const savedSetupM = useSavedSetupMutations();
  const analyses = useSavedAnalyses();
  const analysesM = useSavedAnalysisMutations();
  const journalM = useJournalMutations();
  const L = useAssetLabel();
  const s = settings.data?.settings;
  const [balance, setBalance] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [risk, setRisk] = useState("1");
  const [tfDefault, setTfDefault] = useState<Timeframe>("4h");
  const [tz, setTz] = useState("UTC");
  const [customTz, setCustomTz] = useState("");
  const [theme, setTheme] = useState<"dark" | "light" | "system">("dark");
  const [assets, setAssets] = useState<AssetId[]>([]);
  const [tfs, setTfs] = useState<Timeframe[]>([]);
  const [layout, setLayout] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!s) return;
    setBalance(String(s.accountBalance));
    setCurrency(s.accountCurrency);
    setRisk(String(s.defaultRiskPct));
    setTfDefault(s.defaultTimeframe);
    setTz(s.timezone);
    setTheme(s.theme);
    setAssets(s.followedAssets);
    setTfs(s.followedTimeframes);
    setLayout(s.dashboardLayout?.length ? s.dashboardLayout : WIDGETS.map((w) => w.id));
    setDirty(false);
  }, [s]);
  const mark = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setDirty(true);
  };
  const save = () => {
    const zone = customTz.trim() || tz;
    if (!isValidTimeZone(zone)) {
      ui.pushToast({ title: "Invalid timezone", body: `${zone} is not an IANA zone name`, tone: "bear" });
      return;
    }
    update.mutate(
      { accountBalance: parseFloat(balance) || s?.accountBalance, accountCurrency: currency, defaultRiskPct: parseFloat(risk) || 1, defaultTimeframe: tfDefault, timezone: zone, theme, followedAssets: assets, followedTimeframes: tfs, dashboardLayout: layout },
      {
        onSuccess: () => {
          ui.setTimezone(zone);
          ui.setTheme(theme);
          ui.pushToast({ title: "Settings saved", tone: "bull" });
          setDirty(false);
        },
        onError: (e) => ui.pushToast({ title: "Could not save", body: (e as Error).message, tone: "bear" }),
      },
    );
  };
  const f = features.data;
  return (
    <div className="space-y-4">
      <PageHeader title="Settings" description="Account defaults, followed markets, display preferences, data-source status and saved work. Everything is stored locally by the server in the data directory." actions={<Button variant="primary" disabled={!dirty} loading={update.isPending} onClick={save}>Save changes</Button>} />
      <div className="grid xl:grid-cols-2 gap-4">
        <Card title="Account & risk defaults" subtitle="Used for setup sizing previews and calculator defaults">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Account balance"><Input type="number" value={balance} onChange={(e) => mark(setBalance)(e.target.value)} /></Field>
            <Field label="Account currency"><Select value={currency} onChange={(e) => mark(setCurrency)(e.target.value)}>{["USD", "USDT", "EUR", "GBP", "CHF", "JPY", "AUD", "CAD"].map((c) => <option key={c}>{c}</option>)}</Select></Field>
            <Field label="Default risk per trade (%)" hint="Above 2% is flagged everywhere."><Input type="number" step="0.25" value={risk} onChange={(e) => mark(setRisk)(e.target.value)} /></Field>
            <Field label="Default trading timeframe"><Select value={tfDefault} onChange={(e) => mark(setTfDefault)(e.target.value as Timeframe)}>{TIMEFRAMES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
          </div>
        </Card>
        <Card title="Display" subtitle="Timezone applies to every timestamp, chart and calendar entry">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Timezone"><Select value={tz} onChange={(e) => mark(setTz)(e.target.value)}>{[...new Set([tz, ...TIMEZONES])].map((z) => <option key={z}>{z}</option>)}</Select></Field>
            <Field label="Or type any IANA zone" hint="e.g. Europe/Madrid, America/Sao_Paulo"><Input value={customTz} onChange={(e) => mark(setCustomTz)(e.target.value)} placeholder="Region/City" /></Field>
            <Field label="Theme"><Select value={theme} onChange={(e) => mark(setTheme)(e.target.value as typeof theme)}><option value="dark">Dark</option><option value="light">Light</option><option value="system">Follow system</option></Select></Field>
          </div>
        </Card>
        <Card title="Followed assets" subtitle="Drive the ticker strip, setups page and overview">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {(Object.keys(ASSETS) as AssetId[]).map((a) => {
              const on = assets.includes(a);
              return <button key={a} onClick={() => mark(setAssets)(on ? assets.filter((x) => x !== a) : [...assets, a])} className={cls("flex items-center justify-between rounded-lg border px-3 h-10 text-sm", on ? (isMetalAsset(a) ? `${METAL_SELECTED[METALS[a].metal]} text-ink-1` : "border-accent bg-accent-soft text-ink-1") : "border-line text-ink-2")}><span>{ASSETS[a].symbol}</span><span className="text-xs text-ink-3">{ASSETS[a].name}</span></button>;
            })}
          </div>
          <div className="mt-3 space-y-2">
            <AssetPicker placeholder="Add any other coin from the Binance universe…" exclude={assets} onSelect={(id) => mark(setAssets)([...assets, id])} />
            {assets.filter((a) => !ASSETS[a]).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {assets.filter((a) => !ASSETS[a]).map((a) => <AssetChip key={a} id={a} label={`${L(a).symbol} · ${L(a).name}`} onRemove={() => mark(setAssets)(assets.filter((x) => x !== a))} />)}
              </div>
            )}
          </div>
          <p className="text-sm font-medium text-ink-1 mt-4 mb-2">Followed timeframes</p>
          <div className="flex flex-wrap gap-2">
            {TIMEFRAMES.map((t) => {
              const on = tfs.includes(t);
              return <button key={t} onClick={() => mark(setTfs)(on ? tfs.filter((x) => x !== t) : [...tfs, t])} className={cls("rounded-lg border px-3 h-9 text-sm", on ? "border-accent bg-accent-soft text-ink-1" : "border-line text-ink-2")}>{t}</button>;
            })}
          </div>
        </Card>
        <Card title="Overview layout" subtitle="Choose which widgets the dashboard shows">
          <div className="space-y-2">
            {WIDGETS.map((w) => <Toggle key={w.id} checked={layout.includes(w.id)} onChange={(v) => mark(setLayout)(v ? [...layout, w.id] : layout.filter((x) => x !== w.id))} label={w.label} />)}
          </div>
        </Card>
        <Card title="Data sources & API keys" subtitle="Keys live in the server's .env file and are never sent to the browser">
          <ul className="space-y-2 text-sm">
            <li className="flex items-start justify-between gap-3"><span className="text-ink-2">Crypto prices & derivatives</span><Badge tone="bull">Binance public API (keyless) · Bybit/Coinbase fallback</Badge></li>
            <li className="flex items-start justify-between gap-3"><span className="text-ink-2">Market cap & dominance</span><Badge tone="bull">CoinGecko free API</Badge></li>
            <li className="flex items-start justify-between gap-3"><span className="text-ink-2">Gold spot</span><Badge tone="bull">{f?.goldSpot.provider?.startsWith("twelvedata") ? "Twelve Data + Dukascopy archive + Swissquote live" : "Dukascopy archive + Swissquote live (genuine spot XAU/USD, keyless)"}</Badge></li>
            <li className="flex items-start justify-between gap-3"><span className="text-ink-2">Silver spot</span><Badge tone="bull">{f?.silverSpot?.provider?.startsWith("twelvedata") ? "Twelve Data + Dukascopy archive + Swissquote live" : "Dukascopy archive + Swissquote live (genuine spot XAG/USD, keyless)"}</Badge></li>
            <li className="flex items-start justify-between gap-3"><span className="text-ink-2">Treasury yields</span><Badge tone="neutral">{f?.macro.yields === "fred" ? "FRED (key)" : "home.treasury.gov (keyless)"}</Badge></li>
            <li className="flex items-start justify-between gap-3"><span className="text-ink-2">Dollar index</span><Badge tone="bull">ICE DXY formula on bank FX quotes (Dukascopy archive + Swissquote live)</Badge></li>
            <li className="flex items-start justify-between gap-3"><span className="text-ink-2">Economic calendar</span><Badge tone="neutral">Fed/BLS/BEA published schedules{f?.calendar.forexFactoryFeed ? " + Forex Factory weekly feed" : ""}</Badge></li>
            <li className="flex items-start justify-between gap-3"><span className="text-ink-2">News</span><Badge tone="neutral">Publisher RSS feeds</Badge></li>
            <li className="flex items-start justify-between gap-3"><span className="text-ink-2">AI narratives</span>{f?.ai.enabled ? <Badge tone="accent">Claude · {f.ai.model}</Badge> : <Badge tone="neutral">Rule-based — set ANTHROPIC_API_KEY to enable Claude</Badge>}</li>
            <li className="flex items-start justify-between gap-3"><span className="text-ink-2">Demo mode</span><Badge tone={f?.demoMode === "force" ? "bear" : "neutral"}>{f?.demoMode}</Badge></li>
          </ul>
          <p className="text-xs text-ink-3 mt-3">Edit <code className="text-ink-2">.env</code> (see <code className="text-ink-2">.env.example</code>) and restart the server. Optional keys add Twelve Data as a further spot source for gold and silver, FRED macro series and Claude-written narratives; everything else, including genuine spot gold and silver, runs keyless.</p>
        </Card>
        <Card title="Alerts & monitoring" subtitle={`${alerts.data?.alerts.length ?? 0} rules · ${alerts.data?.triggered.filter((t) => !t.read).length ?? 0} unread`} actions={<Button size="sm" icon={<Bell className="h-3.5 w-3.5" />} onClick={() => ui.setAlertsOpen(true)}>Manage</Button>}>
          <p className="text-sm text-ink-2">Price, setup-status and regime-change alerts are evaluated on the server every 15 seconds and pushed over the live connection. Open the alerts panel (press <kbd className="text-ink-1">a</kbd>) to create or toggle rules.</p>
          <div className="mt-3">
            <Toggle checked={!!s?.autoMonitorSetups} onChange={(v) => update.mutate({ autoMonitorSetups: v }, { onSuccess: () => ui.pushToast({ title: v ? "Auto-monitoring on" : "Auto-monitoring off", body: v ? "Every actionable setup for your followed assets will be tracked against live prices." : undefined }) })} label="Automatically monitor actionable setups" description="Tracks entry, stop and TP1–TP3 for every actionable plan on followed assets (default timeframe). Levels only — no orders." />
          </div>
        </Card>
        <Card title="Saved setups" subtitle="Plans you bookmarked from the Setups page" padded={false}>
          {savedSetups.data?.setups.length ? (
            <ul className="divide-y divide-line">
              {savedSetups.data.setups.map((x) => (
                <li key={x.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                  <StatusBadge status={x.status} size="sm" />
                  <span className="text-ink-1 font-medium">{x.symbol}</span>
                  <span className="text-ink-3 text-xs">{x.direction} · {setupTypeLabel(x.setupType)} · {x.timeframe}</span>
                  <span className="text-xs text-ink-2 tabular hidden sm:inline">E {fmtPrice(x.entry.mid, x.assetId)} · SL {fmtPrice(x.stopLoss, x.assetId)}</span>
                  <span className="ml-auto text-[11px] text-ink-3 tabular">{fmtDateTime(x.generatedAt, ui.timezone)}</span>
                  <Button size="sm" variant="ghost" onClick={() => { ui.setSelectedAsset(x.assetId); ui.setSelectedTimeframe(x.timeframe); navigate("/setups"); }}>Open</Button>
                  <button aria-label="Remove saved setup" className="text-ink-3 hover:text-bear" onClick={() => savedSetupM.remove.mutate(x.id)}><Trash2 className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
          ) : <p className="p-4 text-sm text-ink-3 flex items-center gap-2"><BookmarkCheck className="h-4 w-4" /> Nothing saved yet. Use the bookmark icon on a setup card.</p>}
        </Card>
        <Card title="Saved analyses" subtitle="Multi-timeframe reads saved from the Technical page" padded={false}>
          {analyses.data?.analyses.length ? (
            <ul className="divide-y divide-line">
              {analyses.data.analyses.map((a) => (
                <li key={a.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                  <span className="text-ink-1">{a.title}</span>
                  <span className="ml-auto text-[11px] text-ink-3 tabular">{fmtDateTime(a.createdAt, ui.timezone)}</span>
                  <button aria-label="Remove analysis" className="text-ink-3 hover:text-bear" onClick={() => analysesM.remove.mutate(a.id)}><Trash2 className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
          ) : <p className="p-4 text-sm text-ink-3">No saved analyses.</p>}
        </Card>
        <Card title="Maintenance" subtitle="Local data housekeeping">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" loading={journalM.clearTest.isPending} onClick={() => journalM.clearTest.mutate(undefined, { onSuccess: (d) => ui.pushToast({ title: `${d.removed} test trades removed` }) })}>Remove journal test data</Button>
            <Button size="sm" variant="secondary" onClick={() => update.mutate({ onboardingComplete: false })}>Re-run first-time setup</Button>
          </div>
        </Card>
        <Card title="About" subtitle="Aurum Terminal · MIT License">
          <div className="text-sm text-ink-2 space-y-2">
            <p>Methodologies for regime scoring, position sizing, the discipline gate, circuit breaker and trade-memory workflow are adapted from <a className="text-accent" href="https://github.com/tradermonty/claude-trading-skills" target="_blank" rel="noreferrer noopener">tradermonty/claude-trading-skills</a> (MIT License, © 2026 TraderMonty) and re-implemented for crypto and gold. Attribution details are in docs/ATTRIBUTION.md.</p>
            <p>Charts render with TradingView's open-source lightweight-charts library (Apache 2.0).</p>
            <Disclaimer />
          </div>
        </Card>
      </div>
    </div>
  );
}

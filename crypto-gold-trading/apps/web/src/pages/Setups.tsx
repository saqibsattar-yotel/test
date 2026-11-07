import { useMemo, useState } from "react";
import { Target } from "lucide-react";
import { TIMEFRAMES, type AssetId, type Timeframe, type TradeSetup } from "@terminal/core";
import { Badge, Button, Card, DataNotice, Disclaimer, EmptyState, ErrorState, PageHeader, Segmented, SkeletonBlock, Tabs } from "@/components/ui";
import { MonitorPanel } from "@/components/monitor/MonitorPanel";
import { useMonitor } from "@/lib/queries";
import { AssetChip, AssetPicker } from "@/components/ui/AssetPicker";
import { useAssetLabel } from "@/lib/assets";
import { SetupCard } from "@/components/setups/SetupCard";
import { SetupDrawer } from "@/components/setups/SetupDrawer";
import { TradeForm, prefillFromSetup, type TradePrefill } from "@/components/journal/TradeForm";
import { useSettings, useSetups } from "@/lib/queries";
import { useUiNoQuotes } from "@/lib/store";
import { cls, fmtAge } from "@/lib/format";

type Filter = "all" | "actionable" | "wait" | "none";

export default function Setups() {
  const settings = useSettings();
  const ui = useUiNoQuotes();
  const [tf, setTf] = useState<Timeframe>(ui.selectedTimeframe);
  const [filter, setFilter] = useState<Filter>("all");
  const [dir, setDir] = useState<"all" | "LONG" | "SHORT">("all");
  const [assets, setAssets] = useState<AssetId[] | null>(null);
  const [open, setOpen] = useState<AssetId | null>(null);
  const [paper, setPaper] = useState<TradePrefill | null>(null);
  const [tab, setTab] = useState<"live" | "monitor" | "history">("live");
  const monitorQ = useMonitor();
  const followed = settings.data?.settings.followedAssets ?? ["BTCUSD", "ETHUSD", "SOLUSD", "XAUUSD"];
  const selected = assets ?? followed;
  const L = useAssetLabel();
  const q = useSetups(selected, tf, settings.data?.settings.accountBalance, settings.data?.settings.defaultRiskPct);
  const currency = settings.data?.settings.accountCurrency ?? "USD";
  const list = useMemo(() => {
    let s = q.data?.setups ?? [];
    if (filter === "actionable") s = s.filter((x) => ["STRONG LONG", "LONG", "SHORT", "STRONG SHORT"].includes(x.status));
    if (filter === "wait") s = s.filter((x) => x.status === "WAIT FOR CONFIRMATION" || x.status === "NEUTRAL");
    if (filter === "none") s = s.filter((x) => x.status === "NO TRADE");
    if (dir !== "all") s = s.filter((x) => x.direction === dir);
    return s;
  }, [q.data, filter, dir]);
  const counts = useMemo(() => {
    const s = q.data?.setups ?? [];
    return { actionable: s.filter((x) => ["STRONG LONG", "LONG", "SHORT", "STRONG SHORT"].includes(x.status)).length, wait: s.filter((x) => x.status === "WAIT FOR CONFIRMATION" || x.status === "NEUTRAL").length, none: s.filter((x) => x.status === "NO TRADE").length };
  }, [q.data]);
  const toggleAsset = (a: AssetId) => setAssets(selected.includes(a) ? selected.filter((x) => x !== a) : [...selected, a]);
  const sources = (q.data?.setups ?? []).map((s: TradeSetup) => s.dataSource);

  return (
    <div className="space-y-4">
      <PageHeader title="AI Trade Setups" description="Structured trade plans built from verified structure, indicators and volatility: entry zone, technical stop, three targets, honest quality score — and NO TRADE whenever conditions are unclear. Track a plan to follow entry, stop and targets against live prices." actions={<span className="text-xs text-ink-3">{q.data ? `Generated ${fmtAge(q.data.generatedAt)}` : ""}</span>} />
      <Tabs tabs={[{ value: "live" as const, label: "Live setups" }, { value: "monitor" as const, label: "Monitoring", count: monitorQ.data?.summary.active }, { value: "history" as const, label: "History", count: monitorQ.data?.summary.finished }]} value={tab} onChange={setTab} />
      {tab === "monitor" && <MonitorPanel mode="active" />}
      {tab === "history" && <MonitorPanel mode="history" />}
      {tab === "live" && (<>
      <Card padded={false}>
        <div className="p-3 flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-ink-3">Timeframe</span>
            <Segmented
              size="sm"
              options={TIMEFRAMES.map((t) => ({ value: t, label: t }))}
              value={tf}
              onChange={(t) => {
                setTf(t);
                ui.setSelectedTimeframe(t);
              }}
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-ink-3">Status</span>
            <Segmented size="sm" options={[{ value: "all" as Filter, label: `All ${q.data?.setups.length ?? ""}` }, { value: "actionable" as Filter, label: `Actionable ${counts.actionable}` }, { value: "wait" as Filter, label: `Wait ${counts.wait}` }, { value: "none" as Filter, label: `No trade ${counts.none}` }]} value={filter} onChange={setFilter} />
            <Segmented size="sm" options={[{ value: "all" as const, label: "Both" }, { value: "LONG" as const, label: "Long" }, { value: "SHORT" as const, label: "Short" }]} value={dir} onChange={setDir} />
          </div>
          <div className="flex items-center gap-1.5 flex-wrap lg:ml-auto">
            {selected.map((a) => (
              <AssetChip key={a} id={a} label={L(a).base} tone={a === "XAUUSD" ? "gold" : "accent"} onRemove={() => toggleAsset(a)} />
            ))}
            <AssetPicker size="sm" className="w-56" placeholder="Add coin…" exclude={selected} onSelect={(id) => setAssets([...selected, id as AssetId])} />
          </div>
        </div>
      </Card>

      {sources.length > 0 && <DataNotice sources={sources} />}
      {q.data && Object.keys(q.data.errors).length > 0 && <DataNotice warnings={Object.entries(q.data.errors).map(([a, e]) => `${a}: ${e}`)} />}

      {q.isLoading ? (
        <div className="grid md:grid-cols-2 2xl:grid-cols-3 gap-4">
          {selected.map((a) => (
            <div key={a} className="card p-4">
              <SkeletonBlock lines={9} />
            </div>
          ))}
        </div>
      ) : q.isError ? (
        <ErrorState message={(q.error as Error).message} retry={() => q.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Target className="h-5 w-5" />}
          title={selected.length ? "No setups match this filter" : "Select at least one asset"}
          description={selected.length ? "The engine returns NO TRADE when structure, momentum and timeframes do not line up. That is a feature." : undefined}
          action={
            filter !== "all" ? (
              <Button size="sm" onClick={() => setFilter("all")}>
                Show all
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid md:grid-cols-2 2xl:grid-cols-3 gap-4">
          {list.map((s) => (
            <SetupCard key={s.id} setup={s} currency={currency} onOpen={(x) => setOpen(x.assetId)} onPaperTrade={(x) => setPaper(prefillFromSetup(x))} />
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap text-xs text-ink-3">
        <Badge tone="bull" size="sm">
          STRONG LONG / LONG
        </Badge>
        <Badge tone="bear" size="sm">
          STRONG SHORT / SHORT
        </Badge>
        <Badge tone="warning" size="sm">
          WAIT FOR CONFIRMATION
        </Badge>
        <Badge tone="neutral" size="sm">
          NEUTRAL
        </Badge>
        <Badge tone="muted" size="sm">
          NO TRADE
        </Badge>
        <span>· Quality ≥ 75 strong, 60–74 actionable, 45–59 wait, below 45 neutral; hard NO TRADE when TP1 &lt; 1R, TP2 &lt; 1.5R, the stop is inside noise, or data is stale.</span>
      </div>
      <Disclaimer />
      </>)}

      <SetupDrawer assetId={open} timeframe={tf} onClose={() => setOpen(null)} />
      <TradeForm open={!!paper} onClose={() => setPaper(null)} prefill={paper} />
    </div>
  );
}

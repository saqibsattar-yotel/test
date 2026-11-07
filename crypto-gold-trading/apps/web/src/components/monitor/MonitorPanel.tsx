import { useState } from "react";
import { Radar, Trash2, XCircle } from "lucide-react";
import type { MonitoredSetup } from "@terminal/core";
import { Badge, Button, Card, Disclaimer, EmptyState, SkeletonBlock, Tooltip, type Tone } from "@/components/ui";
import { useMonitor, useMonitorMutations } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cls, fmtAge, fmtDateTime, fmtPrice, fmtR, setupTypeLabel } from "@/lib/format";

export function statusTone(status: MonitoredSetup["status"]): Tone {
  switch (status) {
    case "watching":
      return "accent";
    case "entry_reached":
      return "gold";
    case "tp1_reached":
    case "tp2_reached":
    case "tp3_reached":
      return "bull";
    case "stopped":
      return "bear";
    case "expired":
    case "cancelled":
      return "muted";
    default:
      return "neutral";
  }
}
export function statusLabel(status: MonitoredSetup["status"]): string {
  return { watching: "Watching for entry", entry_reached: "Entry zone reached", tp1_reached: "TP1 reached", tp2_reached: "TP2 reached", tp3_reached: "TP3 reached — complete", stopped: "Stop level reached", expired: "Expired (no entry)", cancelled: "Cancelled", closed: "Closed manually" }[status];
}

function LevelProgress({ m, price }: { m: MonitoredSetup; price: number | null }) {
  const s = m.setup;
  if (s.stopLoss === null) return null;
  const long = m.direction === "LONG";
  const pts = [s.stopLoss, s.entry.low, s.entry.high, ...s.targets.map((t) => t.price), ...(price ? [price] : [])];
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const x = (p: number) => ((p - min) / (max - min || 1)) * 100;
  return (
    <div className="relative h-7 mt-1">
      <div className="absolute inset-x-0 top-3 h-1.5 rounded-full bg-surface-3" />
      <div className="absolute top-3 h-1.5 rounded-full bg-bear/60" style={{ left: `${Math.min(x(s.stopLoss), x(s.entry.mid))}%`, width: `${Math.abs(x(s.entry.mid) - x(s.stopLoss))}%` }} />
      <div className="absolute top-3 h-1.5 rounded-full bg-bull/50" style={{ left: `${Math.min(x(s.entry.mid), x(s.targets[2].price))}%`, width: `${Math.abs(x(s.targets[2].price) - x(s.entry.mid))}%` }} />
      <div className="absolute top-2 h-3.5 rounded bg-accent" style={{ left: `${Math.min(x(s.entry.low), x(s.entry.high))}%`, width: `${Math.max(1.5, Math.abs(x(s.entry.high) - x(s.entry.low)))}%` }} title="entry zone" />
      {s.targets.map((t, i) => (
        <span key={t.label} className={cls("absolute top-1 w-0.5 h-5 rounded", m.hits[`tp${i + 1}` as "tp1"] ? "bg-bull" : "bg-bull/40")} style={{ left: `${x(t.price)}%` }} title={`${t.label} ${t.price}`} />
      ))}
      <span className={cls("absolute top-1 w-0.5 h-5 rounded", m.hits.stop ? "bg-bear" : "bg-bear/50")} style={{ left: `${x(s.stopLoss)}%` }} title={`stop ${s.stopLoss}`} />
      {price !== null && <span className="absolute -top-0.5 h-2 w-2 rotate-45 bg-ink-1" style={{ left: `calc(${x(price)}% - 4px)` }} title={`now ${price}`} />}
      <span className="absolute -bottom-1 left-0 text-[9px] text-ink-3 tabular">{fmtPrice(long ? s.stopLoss : s.targets[2].price, m.assetId)}</span>
      <span className="absolute -bottom-1 right-0 text-[9px] text-ink-3 tabular">{fmtPrice(long ? s.targets[2].price : s.stopLoss, m.assetId)}</span>
    </div>
  );
}

function nextLevel(m: MonitoredSetup, price: number | null): string {
  const s = m.setup;
  if (s.stopLoss === null || price === null) return "—";
  const pct = (p: number) => `${(((p - price) / price) * 100).toFixed(2)}%`;
  if (!m.entryReached) return `entry ${fmtPrice(s.entry.mid, m.assetId)} (${pct(s.entry.mid)})`;
  const nextTp = s.targets.find((_, i) => !m.hits[`tp${i + 1}` as "tp1"]);
  return `${nextTp ? `${nextTp.label} ${fmtPrice(nextTp.price, m.assetId)} (${pct(nextTp.price)})` : "all targets reached"} · stop ${fmtPrice(s.stopLoss, m.assetId)} (${pct(s.stopLoss)})`;
}

export function MonitorPanel({ mode }: { mode: "active" | "history" }) {
  const q = useMonitor();
  const m = useMonitorMutations();
  const quotes = useUi((s) => s.quotes);
  const tz = useUi((s) => s.timezone);
  const [open, setOpen] = useState<string | null>(null);
  const list = mode === "active" ? q.data?.active ?? [] : q.data?.history ?? [];
  const sum = q.data?.summary;
  return (
    <div className="space-y-4">
      {sum && (
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2 text-xs">
          {[
            ["Active", sum.active],
            ["Watching", sum.watching],
            ["Entered", sum.entered],
            ["Finished", sum.finished],
            ["Completed (TP3)", sum.completed],
            ["Stopped", sum.stopped],
            ["Avg outcome", sum.avgOutcomeR !== null ? fmtR(sum.avgOutcomeR) : "—"],
          ].map(([k, v]) => (
            <div key={String(k)} className="card px-3 py-2">
              <div className="text-ink-3">{k}</div>
              <div className="text-base font-semibold text-ink-1 tabular">{v as string | number}</div>
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px] text-ink-3">{q.data?.note ?? "Levels are monitored against streamed prices; reaching a level is recorded as an event. No order is ever placed or assumed."}</p>
      {q.isLoading ? (
        <SkeletonBlock lines={6} />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState icon={<Radar className="h-5 w-5" />} title={mode === "active" ? "Nothing is being monitored" : "No finished plans yet"} description={mode === "active" ? "Use “Track” on a setup card, or enable automatic monitoring in Settings. Each plan is followed through entry, TP1–TP3 and stop with one alert per event." : "Finished plans (stopped, completed, expired or closed) are kept here with their event history and outcome in R."} />
        </Card>
      ) : (
        <div className="grid lg:grid-cols-2 gap-3">
          {list.map((item) => {
            const live = quotes[item.assetId]?.price ?? item.lastPrice;
            const isOpen = open === item.id;
            return (
              <Card key={item.id} padded={false}>
                <div className="p-3 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-ink-1">{item.symbol}</span>
                    <Badge tone={item.direction === "LONG" ? "bull" : "bear"} size="sm">
                      {item.direction}
                    </Badge>
                    <Badge tone="neutral" size="sm">
                      {item.timeframe}
                    </Badge>
                    <span className="text-xs text-ink-3">{setupTypeLabel(item.setup.setupType)}</span>
                    <Badge tone={statusTone(item.status)} className="ml-auto font-semibold">
                      {statusLabel(item.status)}
                    </Badge>
                  </div>
                  <LevelProgress m={item} price={live} />
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 text-[11px] mt-2">
                    <div>
                      <div className="text-ink-3">Now</div>
                      <div className="tabular text-ink-1">{live ? fmtPrice(live, item.assetId) : "—"}</div>
                    </div>
                    <div className="col-span-2">
                      <div className="text-ink-3">Next level</div>
                      <div className="tabular text-ink-1 truncate" title={nextLevel(item, live)}>
                        {nextLevel(item, live)}
                      </div>
                    </div>
                    <div>
                      <div className="text-ink-3">{item.final ? "Outcome" : "MFE / MAE"}</div>
                      <div className={cls("tabular font-semibold", item.final ? ((item.outcomeR ?? 0) >= 0 ? "text-bull" : "text-bear") : "text-ink-1")}>{item.final ? (item.outcomeR !== null ? fmtR(item.outcomeR) : "—") : `${fmtR(item.mfeR)} / ${fmtR(item.maeR)}`}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 text-[11px]">
                    {(["tp1", "tp2", "tp3"] as const).map((k) => (
                      <span key={k} className={cls("px-1.5 h-5 inline-flex items-center rounded", item.hits[k] ? "bg-bull-soft text-bull" : "bg-surface-3 text-ink-3")}>
                        {k.toUpperCase()}
                      </span>
                    ))}
                    <span className={cls("px-1.5 h-5 inline-flex items-center rounded", item.hits.stop ? "bg-bear-soft text-bear" : "bg-surface-3 text-ink-3")}>SL</span>
                    <span className="ml-auto text-ink-3">
                      {item.source} · tracked {fmtAge(item.createdAt)}
                      {item.lastCheckedAt ? ` · checked ${fmtAge(item.lastCheckedAt)}` : ""}
                    </span>
                  </div>
                </div>
                <div className="px-3 py-2 border-t border-line flex items-center gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => setOpen(isOpen ? null : item.id)}>
                    {isOpen ? "Hide events" : `Events (${item.events.length})`}
                  </Button>
                  {!item.final && (
                    <>
                      <Tooltip content="Stop monitoring (kept in history)">
                        <Button size="sm" variant="ghost" icon={<XCircle className="h-3.5 w-3.5" />} onClick={() => m.cancel.mutate(item.id)}>
                          Cancel
                        </Button>
                      </Tooltip>
                      {item.entryReached && (
                        <Tooltip content="Record a manual close at the current price (no order is sent)">
                          <Button size="sm" variant="ghost" onClick={() => m.close.mutate(item.id)}>
                            Close at market
                          </Button>
                        </Tooltip>
                      )}
                    </>
                  )}
                  {item.final && (
                    <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => m.remove.mutate(item.id)}>
                      Remove
                    </Button>
                  )}
                </div>
                {isOpen && (
                  <ul className="px-3 pb-3 space-y-1 text-xs">
                    {item.events.length === 0 && <li className="text-ink-3">No events yet.</li>}
                    {item.events.map((e) => (
                      <li key={e.id} className="flex gap-2">
                        <span className="tabular text-ink-3 shrink-0">{fmtDateTime(e.time, tz)}</span>
                        <span className="text-ink-2">{e.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      )}
      <Disclaimer />
    </div>
  );
}

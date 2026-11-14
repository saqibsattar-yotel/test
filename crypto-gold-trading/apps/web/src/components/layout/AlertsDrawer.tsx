import { useEffect, useState } from "react";
import { BellRing, Trash2 } from "lucide-react";
import { TIMEFRAMES, type AssetId, type Timeframe } from "@terminal/core";
import { Badge, Button, Drawer, EmptyState, Field, Input, Select, Toggle } from "@/components/ui";
import { AssetPicker } from "@/components/ui/AssetPicker";
import { useAssetLabel } from "@/lib/assets";
import { useAlertMutations, useAlerts, useSettings } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { fmtDateTime, fmtPrice } from "@/lib/format";

export function AlertsDrawer() {
  const open = useUi((s) => s.alertsOpen);
  const setOpen = useUi((s) => s.setAlertsOpen);
  const setUnread = useUi((s) => s.setUnreadAlerts);
  const tz = useUi((s) => s.timezone);
  const alerts = useAlerts();
  const m = useAlertMutations();
  const settings = useSettings();
  const L = useAssetLabel();
  useEffect(() => {
    if (open && alerts.data?.triggered.some((t) => !t.read)) {
      m.markRead.mutate();
      setUnread(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, alerts.data]);
  return (
    <Drawer open={open} onClose={() => setOpen(false)} title="Alerts" width="max-w-lg">
      <AlertForm defaultAsset={settings.data?.settings.followedAssets[0] ?? "BTCUSD"} />
      <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3 mt-6 mb-2">Rules</h3>
      {alerts.data?.alerts.length ? (
        <ul className="space-y-2">
          {alerts.data.alerts.map((a) => (
            <li key={a.id} className="card px-3 py-2.5 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink-1 truncate">
                  {a.kind === "price_above" && `${L(a.assetId!).symbol} above ${fmtPrice(a.level, a.assetId)}`}
                  {a.kind === "price_below" && `${L(a.assetId!).symbol} below ${fmtPrice(a.level, a.assetId)}`}
                  {a.kind === "setup_status" && `${L(a.assetId!).symbol} ${a.timeframe ?? "4h"} setup becomes actionable`}
                  {a.kind === "regime_change" && "Crypto regime, gold or silver posture zone change"}
                </div>
                <div className="text-[11px] text-ink-3">
                  {a.triggerCount} trigger{a.triggerCount === 1 ? "" : "s"}
                  {a.lastTriggeredAt ? ` · last ${fmtDateTime(a.lastTriggeredAt, tz)}` : ""}
                  {a.note ? ` · ${a.note}` : ""}
                </div>
              </div>
              <Toggle checked={a.active} onChange={(active) => m.toggle.mutate({ id: a.id, active })} />
              <button aria-label="Delete alert" className="text-ink-3 hover:text-bear" onClick={() => m.remove.mutate(a.id)}>
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState compact icon={<BellRing className="h-5 w-5" />} title="No alert rules yet" description="Create price, setup or regime alerts above. They are evaluated server-side and pushed here in real time." />
      )}
      <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3 mt-6 mb-2">Recent triggers</h3>
      {alerts.data?.triggered.length ? (
        <ul className="space-y-1.5">
          {alerts.data.triggered.slice(0, 30).map((t) => (
            <li key={t.id} className="flex items-start gap-2 text-sm">
              <Badge tone={t.kind.startsWith("price") ? "accent" : t.kind === "setup_status" ? "gold" : t.kind === "setup_monitor" ? "bull" : "warning"} size="sm">
                {t.kind === "setup_monitor" ? "monitor" : t.kind.replace("_", " ")}
              </Badge>
              <span className="text-ink-2 flex-1">{t.message}</span>
              <span className="text-[11px] text-ink-3 tabular shrink-0">{fmtDateTime(t.time, tz)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-ink-3">Nothing has triggered yet.</p>
      )}
    </Drawer>
  );
}

function AlertForm({ defaultAsset }: { defaultAsset: AssetId }) {
  const m = useAlertMutations();
  const quotes = useUi((s) => s.quotes);
  const [kind, setKind] = useState<"price_above" | "price_below" | "setup_status" | "regime_change">("price_above");
  const [asset, setAsset] = useState<AssetId>(defaultAsset);
  const [tf, setTf] = useState<Timeframe>("4h");
  const [level, setLevel] = useState("");
  const [note, setNote] = useState("");
  const q = quotes[asset];
  const submit = () => {
    const body: Record<string, unknown> = { kind, note: note || undefined };
    if (kind !== "regime_change") body.assetId = asset;
    if (kind === "price_above" || kind === "price_below") body.level = parseFloat(level);
    if (kind === "setup_status") body.timeframe = tf;
    m.create.mutate(body, { onSuccess: () => setLevel("") });
  };
  const valid = kind === "regime_change" || kind === "setup_status" || (level !== "" && Number.isFinite(parseFloat(level)) && parseFloat(level) > 0);
  return (
    <div className="card p-3 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Type">
          <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="price_above">Price crosses above</option>
            <option value="price_below">Price crosses below</option>
            <option value="setup_status">Setup becomes actionable</option>
            <option value="regime_change">Regime zone changes</option>
          </Select>
        </Field>
        {kind !== "regime_change" && (
          <Field label="Asset">
            <AssetPicker value={asset} onSelect={(id) => setAsset(id as AssetId)} />
          </Field>
        )}
        {(kind === "price_above" || kind === "price_below") && (
          <Field label="Price level" hint={q ? `Current ${fmtPrice(q.price, asset)}` : undefined}>
            <Input type="number" inputMode="decimal" value={level} onChange={(e) => setLevel(e.target.value)} placeholder={q ? fmtPrice(q.price, asset).replace(/,/g, "") : "0.00"} />
          </Field>
        )}
        {kind === "setup_status" && (
          <Field label="Timeframe">
            <Select value={tf} onChange={(e) => setTf(e.target.value as Timeframe)}>
              {TIMEFRAMES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Note (optional)" className={kind === "regime_change" ? "col-span-2" : ""}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. prior-week high" />
        </Field>
      </div>
      <Button variant="primary" size="sm" disabled={!valid} loading={m.create.isPending} onClick={submit}>
        Create alert
      </Button>
    </div>
  );
}

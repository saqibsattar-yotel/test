import { useEffect, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { assetBase, resolveAsset, TIMEFRAMES, riskReward, type AssetId, type Timeframe, type TradeSetup } from "@terminal/core";
import { Button, Field, Input, Modal, Select, Toggle } from "@/components/ui";
import { AssetPicker } from "@/components/ui/AssetPicker";
import { useAssetLabel } from "@/lib/assets";
import { useJournalMutations, useSettings } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { fmtNum } from "@/lib/format";

const SETUP_TYPES = ["trend_pullback", "breakout", "breakdown", "range_fade", "mean_reversion", "liquidity_sweep_reversal", "other"];

export interface TradePrefill {
  assetId?: AssetId;
  direction?: "LONG" | "SHORT";
  entry?: number;
  stop?: number;
  takeProfit?: number | null;
  setupType?: string;
  timeframe?: Timeframe;
  quantity?: number;
  quantityUnit?: string;
  riskPct?: number;
  riskAmount?: number;
  entryReasoning?: string;
  source?: "manual" | "setup" | "paper";
  setupId?: string;
}

export function prefillFromSetup(s: TradeSetup): TradePrefill {
  return {
    assetId: s.assetId,
    direction: s.direction ?? "LONG",
    entry: s.entry.mid,
    stop: s.stopLoss ?? undefined,
    takeProfit: s.targets[1]?.price ?? s.targets[0]?.price ?? null,
    setupType: s.setupType ?? "other",
    timeframe: s.timeframe,
    quantity: s.sizingPreview?.quantity,
    quantityUnit: s.sizingPreview?.quantityUnit ?? (s.assetId === "XAUUSD" ? "lots" : assetBase(s.assetId)),
    riskPct: s.sizingPreview?.riskPct,
    riskAmount: s.sizingPreview?.riskAmount,
    entryReasoning: [`From AI setup ${s.id} (${s.status}, quality ${s.qualityScore}).`, ...s.rationale].join("\n"),
    source: "paper",
    setupId: s.id,
  };
}

export function TradeForm({ open, onClose, prefill }: { open: boolean; onClose: () => void; prefill?: TradePrefill | null }) {
  const m = useJournalMutations();
  const settings = useSettings();
  const L = useAssetLabel();
  const pushToast = useUi((s) => s.pushToast);
  const quotes = useUi((s) => s.quotes);
  const [assetId, setAssetId] = useState<AssetId>("BTCUSD");
  const [direction, setDirection] = useState<"LONG" | "SHORT">("LONG");
  const [setupType, setSetupType] = useState("trend_pullback");
  const [timeframe, setTimeframe] = useState<Timeframe>("4h");
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [tp, setTp] = useState("");
  const [qty, setQty] = useState("");
  const [qtyUnit, setQtyUnit] = useState("BTC");
  const [riskPct, setRiskPct] = useState("1");
  const [riskAmount, setRiskAmount] = useState("");
  const [reason, setReason] = useState("");
  const [tags, setTags] = useState("");
  const [paper, setPaper] = useState(false);
  const [test, setTest] = useState(false);
  const [shots, setShots] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const p = prefill ?? {};
    setAssetId(p.assetId ?? "BTCUSD");
    setDirection(p.direction ?? "LONG");
    setSetupType(p.setupType ?? "trend_pullback");
    setTimeframe(p.timeframe ?? settings.data?.settings.defaultTimeframe ?? "4h");
    setEntry(p.entry !== undefined ? String(p.entry) : quotes[p.assetId ?? "BTCUSD"]?.price?.toString() ?? "");
    setStop(p.stop !== undefined ? String(p.stop) : "");
    setTp(p.takeProfit !== undefined && p.takeProfit !== null ? String(p.takeProfit) : "");
    setQty(p.quantity !== undefined ? String(p.quantity) : "");
    setQtyUnit(p.quantityUnit ?? ((p.assetId ?? "BTCUSD") === "XAUUSD" ? "lots" : assetBase(p.assetId ?? "BTCUSD")));
    setRiskPct(String(p.riskPct ?? settings.data?.settings.defaultRiskPct ?? 1));
    setRiskAmount(p.riskAmount !== undefined ? String(Math.round(p.riskAmount * 100) / 100) : "");
    setReason(p.entryReasoning ?? "");
    setPaper(p.source === "paper");
    setTest(false);
    setTags("");
    setShots([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefill]);
  const e = parseFloat(entry);
  const s = parseFloat(stop);
  const t = parseFloat(tp);
  const geometryOk = Number.isFinite(e) && Number.isFinite(s) && (direction === "LONG" ? s < e : s > e);
  const tpOk = tp === "" || (Number.isFinite(t) && (direction === "LONG" ? t > e : t < e));
  const rr = geometryOk && Number.isFinite(t) ? riskReward(e, s, t) : null;
  const contractSize = assetId === "XAUUSD" && qtyUnit === "lots" ? 100 : 1;
  const derivedRisk = geometryOk && Number.isFinite(parseFloat(qty)) ? Math.abs(e - s) * parseFloat(qty) * contractSize : null;
  const addFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files)
      .slice(0, 6 - shots.length)
      .forEach((f) => {
        if (f.size > 2_000_000) {
          pushToast({ title: "Screenshot too large", body: `${f.name} exceeds 2 MB`, tone: "warning" });
          return;
        }
        const r = new FileReader();
        r.onload = () => setShots((prev) => [...prev, String(r.result)]);
        r.readAsDataURL(f);
      });
  };
  const submit = () => {
    m.create.mutate(
      {
        assetId,
        direction,
        setupType,
        timeframe,
        entry: e,
        stop: s,
        takeProfit: tp === "" ? null : t,
        quantity: parseFloat(qty),
        quantityUnit: qtyUnit,
        riskPct: parseFloat(riskPct) || 0,
        riskAmount: parseFloat(riskAmount) || derivedRisk || 0,
        entryReasoning: reason,
        screenshots: shots,
        tags: tags.split(",").map((x) => x.trim()).filter(Boolean),
        source: paper ? "paper" : prefill?.setupId ? "setup" : "manual",
        isTestData: test,
        setupId: prefill?.setupId,
      },
      {
        onSuccess: () => {
          pushToast({ title: "Trade logged", body: `${L(assetId).symbol} ${direction} recorded in the journal`, tone: "bull" });
          onClose();
        },
        onError: (err) => pushToast({ title: "Could not save trade", body: (err as Error).message, tone: "bear" }),
      },
    );
  };
  const valid = geometryOk && tpOk && Number.isFinite(parseFloat(qty)) && parseFloat(qty) > 0;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={prefill?.setupId ? "Add setup to paper-trading journal" : "Log a trade"}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} loading={m.create.isPending} onClick={submit}>
            Save trade
          </Button>
        </>
      }
    >
      <div className="grid sm:grid-cols-4 gap-3">
        <Field label="Asset">
          <AssetPicker
            value={assetId}
            onSelect={(id) => {
              setAssetId(id as AssetId);
              setQtyUnit(id === "XAUUSD" ? "lots" : resolveAsset(id).base);
            }}
          />
        </Field>
        <Field label="Direction">
          <Select value={direction} onChange={(ev) => setDirection(ev.target.value as "LONG" | "SHORT")}>
            <option>LONG</option>
            <option>SHORT</option>
          </Select>
        </Field>
        <Field label="Setup type">
          <Select value={setupType} onChange={(ev) => setSetupType(ev.target.value)}>
            {SETUP_TYPES.map((x) => (
              <option key={x} value={x}>
                {x.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Timeframe">
          <Select value={timeframe} onChange={(ev) => setTimeframe(ev.target.value as Timeframe)}>
            {TIMEFRAMES.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </Select>
        </Field>
        <Field label="Entry price">
          <Input type="number" inputMode="decimal" value={entry} onChange={(ev) => setEntry(ev.target.value)} />
        </Field>
        <Field label="Stop-loss" hint="Must be below entry for LONG, above for SHORT">
          <Input type="number" inputMode="decimal" value={stop} onChange={(ev) => setStop(ev.target.value)} className={stop !== "" && !geometryOk ? "border-bear" : ""} />
        </Field>
        <Field label="Take-profit (optional)">
          <Input type="number" inputMode="decimal" value={tp} onChange={(ev) => setTp(ev.target.value)} className={!tpOk ? "border-bear" : ""} />
        </Field>
        <Field label="R:R to TP">
          <div className="h-9 flex items-center text-sm tabular text-ink-1">{rr !== null ? `${fmtNum(rr, 2)}R` : "—"}</div>
        </Field>
        <Field label="Quantity">
          <Input type="number" inputMode="decimal" value={qty} onChange={(ev) => setQty(ev.target.value)} />
        </Field>
        <Field label="Unit">
          <Input value={qtyUnit} onChange={(ev) => setQtyUnit(ev.target.value)} />
        </Field>
        <Field label="Risk %">
          <Input type="number" inputMode="decimal" step="0.25" value={riskPct} onChange={(ev) => setRiskPct(ev.target.value)} />
        </Field>
        <Field label={`Risk amount (${settings.data?.settings.accountCurrency ?? "USD"})`} hint="Left blank it is derived from quantity × stop distance (× 100 oz for gold lots).">
          <Input type="number" inputMode="decimal" value={riskAmount} onChange={(ev) => setRiskAmount(ev.target.value)} placeholder={derivedRisk !== null ? fmtNum(derivedRisk, 2) : ""} />
        </Field>
        <Field label="Entry reasoning" className="sm:col-span-4">
          <textarea value={reason} onChange={(ev) => setReason(ev.target.value)} rows={4} className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-1 placeholder:text-ink-3 focus:border-accent" placeholder="Why this trade, what confirms it, what invalidates it…" />
        </Field>
        <Field label="Tags (comma separated)" className="sm:col-span-2">
          <Input value={tags} onChange={(ev) => setTags(ev.target.value)} placeholder="london-open, retest" />
        </Field>
        <div className="sm:col-span-2 flex flex-col gap-2 justify-end">
          <Toggle checked={paper} onChange={setPaper} label="Paper trade" description="Not placed at a broker" />
          <Toggle checked={test} onChange={setTest} label="Mark as test data" description="Excluded from real performance statistics" />
        </div>
        <div className="sm:col-span-4">
          <p className="text-xs font-medium text-ink-2 mb-1.5">Screenshots ({shots.length}/6)</p>
          <div className="flex gap-2 flex-wrap">
            {shots.map((src, i) => (
              <div key={i} className="relative h-20 w-28 rounded-lg overflow-hidden border border-line">
                <img src={src} alt={`Screenshot ${i + 1}`} className="h-full w-full object-cover" />
                <button aria-label="Remove screenshot" className="absolute top-1 right-1 h-5 w-5 rounded bg-black/60 text-white flex items-center justify-center" onClick={() => setShots(shots.filter((_, j) => j !== i))}>
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {shots.length < 6 && (
              <button onClick={() => fileRef.current?.click()} className="h-20 w-28 rounded-lg border border-dashed border-line-strong text-ink-3 hover:text-ink-1 hover:bg-surface-2 flex flex-col items-center justify-center gap-1 text-xs">
                <ImagePlus className="h-4 w-4" />
                Add
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(ev) => addFiles(ev.target.files)} />
          </div>
        </div>
      </div>
    </Modal>
  );
}

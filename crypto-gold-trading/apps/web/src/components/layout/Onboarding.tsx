import { useEffect, useState } from "react";
import { ASSETS, TIMEFRAMES, type AssetId, type Timeframe } from "@terminal/core";
import { Badge, Button, Field, Input, Modal, Select, Toggle } from "@/components/ui";
import { AssetChip, AssetPicker } from "@/components/ui/AssetPicker";
import { useAssetLabel } from "@/lib/assets";
import { useFeatures, useSettings, useUpdateSettings } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cls } from "@/lib/format";

export const TIMEZONES = ["UTC", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Zurich", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Hong_Kong", "Asia/Tokyo", "Australia/Sydney"];

export function Onboarding() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const features = useFeatures();
  const ui = useUi();
  const [step, setStep] = useState(0);
  const [assets, setAssets] = useState<AssetId[]>(["BTCUSD", "ETHUSD", "SOLUSD", "XAUUSD"]);
  const [tfs, setTfs] = useState<Timeframe[]>(["15m", "1h", "4h", "1d"]);
  const [balance, setBalance] = useState("10000");
  const [currency, setCurrency] = useState("USD");
  const [risk, setRisk] = useState("1");
  const [tz, setTz] = useState(ui.timezone);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [ack, setAck] = useState(false);
  const L = useAssetLabel();
  const open = !!settings.data && !settings.data.settings.onboardingComplete;
  useEffect(() => {
    if (settings.data) {
      const s = settings.data.settings;
      setAssets(s.followedAssets);
      setTfs(s.followedTimeframes);
      setBalance(String(s.accountBalance));
      setCurrency(s.accountCurrency);
      setRisk(String(s.defaultRiskPct));
    }
  }, [settings.data]);
  if (!open) return null;
  const finish = () => {
    update.mutate(
      { followedAssets: assets, followedTimeframes: tfs, accountBalance: parseFloat(balance) || 10000, accountCurrency: currency, defaultRiskPct: parseFloat(risk) || 1, timezone: tz, theme, onboardingComplete: true },
      {
        onSuccess: () => {
          ui.setTimezone(tz);
          ui.setTheme(theme);
        },
      },
    );
  };
  const steps = ["Welcome", "Markets", "Account", "Display"];
  return (
    <Modal open title={`Set up your terminal · ${steps[step]}`} onClose={() => {}} wide={step === 1}>
      <div className="flex items-center gap-2 mb-5">
        {steps.map((s, i) => (
          <span key={s} className={cls("h-1.5 flex-1 rounded-full", i <= step ? "bg-accent" : "bg-surface-3")} />
        ))}
      </div>
      {step === 0 && (
        <div className="space-y-4 text-sm text-ink-2">
          <p className="text-ink-1 text-base font-medium">A research and decision-support terminal for crypto and gold — not a signal service.</p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>Every number is computed from the data sources shown next to it. Stale, proxy and demo data are always labelled.</li>
            <li>Trade setups are structured plans with entry, stop, targets and an honest quality score. The engine will say NO TRADE often.</li>
            <li>Position sizing and risk math are deterministic. Narrative explanations are interpretation and can be wrong.</li>
            <li>There are no order buttons. Nothing here executes trades.</li>
          </ul>
          <div className="card p-3 text-xs space-y-1.5">
            <p className="font-medium text-ink-1">Data sources detected</p>
            <p>
              Gold spot:{" "}
              <Badge tone="bull" size="sm">
                {features.data?.goldSpot.provider?.startsWith("twelvedata") ? "Twelve Data + Dukascopy + Swissquote (spot XAU/USD)" : "Dukascopy archive + Swissquote live (spot XAU/USD)"}
              </Badge>
            </p>
            <p>
              AI narratives:{" "}
              {features.data?.ai.enabled ? (
                <Badge tone="bull" size="sm">
                  {features.data.ai.model}
                </Badge>
              ) : (
                <Badge tone="neutral" size="sm">
                  rule-based explainer (add ANTHROPIC_API_KEY to enable Claude)
                </Badge>
              )}
            </p>
            <p>
              Dollar index:{" "}
              <Badge tone="neutral" size="sm">
                {features.data?.macro.dollarIndex === "ice-formula-dukascopy+swissquote" ? "ICE formula on bank FX quotes" : features.data?.macro.dollarIndex}
              </Badge>{" "}
              · Yields:{" "}
              <Badge tone="neutral" size="sm">
                {features.data?.macro.yields}
              </Badge>
            </p>
          </div>
          <Toggle checked={ack} onChange={setAck} label="I understand this is research tooling, not financial advice." />
        </div>
      )}
      {step === 1 && (
        <div className="space-y-5">
          <div>
            <p className="text-sm font-medium text-ink-1 mb-2">Assets to follow</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {(Object.keys(ASSETS) as AssetId[]).map((a) => {
                const on = assets.includes(a);
                return (
                  <button key={a} onClick={() => setAssets(on ? assets.filter((x) => x !== a) : [...assets, a])} className={cls("flex items-center justify-between rounded-lg border px-3 h-10 text-sm", on ? "border-accent bg-accent-soft text-ink-1" : "border-line text-ink-2")}>
                    <span>{ASSETS[a].symbol}</span>
                    <span className="text-xs text-ink-3">{ASSETS[a].name}</span>
                  </button>
                );
              })}
            </div>
            <div className="mt-3 space-y-2">
              <AssetPicker placeholder="Add any other coin — POL, ENA, SUI, HYPE…" exclude={assets} onSelect={(id) => setAssets([...assets, id])} />
              {assets.filter((a) => !ASSETS[a]).length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {assets
                    .filter((a) => !ASSETS[a])
                    .map((a) => (
                      <AssetChip key={a} id={a} label={L(a).symbol} onRemove={() => setAssets(assets.filter((x) => x !== a))} />
                    ))}
                </div>
              )}
            </div>
          </div>
          <div>
            <p className="text-sm font-medium text-ink-1 mb-2">Timeframes</p>
            <div className="flex flex-wrap gap-2">
              {TIMEFRAMES.map((t) => {
                const on = tfs.includes(t);
                return (
                  <button key={t} onClick={() => setTfs(on ? tfs.filter((x) => x !== t) : [...tfs, t])} className={cls("rounded-lg border px-3 h-9 text-sm", on ? "border-accent bg-accent-soft text-ink-1" : "border-line text-ink-2")}>
                    {t}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {step === 2 && (
        <div className="grid sm:grid-cols-3 gap-4">
          <Field label="Account balance">
            <Input type="number" value={balance} onChange={(e) => setBalance(e.target.value)} />
          </Field>
          <Field label="Currency">
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {["USD", "EUR", "GBP", "CHF", "JPY", "AUD", "CAD", "USDT"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label="Default risk per trade (%)" hint="1% is the common professional default; above 2% is flagged.">
            <Input type="number" step="0.25" value={risk} onChange={(e) => setRisk(e.target.value)} />
          </Field>
          <p className="sm:col-span-3 text-xs text-ink-3">Used for position-size previews on setup cards and the risk calculator defaults. Stored locally on this machine.</p>
        </div>
      )}
      {step === 3 && (
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Timezone" hint="All event times and charts use this zone.">
            <Select value={tz} onChange={(e) => setTz(e.target.value)}>
              {[...new Set([tz, ...TIMEZONES])].map((z) => (
                <option key={z}>{z}</option>
              ))}
            </Select>
          </Field>
          <Field label="Theme">
            <Select value={theme} onChange={(e) => setTheme(e.target.value as "dark" | "light")}>
              <option value="dark">Dark (default)</option>
              <option value="light">Light</option>
            </Select>
          </Field>
        </div>
      )}
      <div className="flex items-center justify-between mt-6">
        <Button variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>
          Back
        </Button>
        {step < 3 ? (
          <Button variant="primary" disabled={(step === 0 && !ack) || (step === 1 && (!assets.length || !tfs.length))} onClick={() => setStep(step + 1)}>
            Continue
          </Button>
        ) : (
          <Button variant="primary" loading={update.isPending} onClick={finish}>
            Open the terminal
          </Button>
        )}
      </div>
    </Modal>
  );
}

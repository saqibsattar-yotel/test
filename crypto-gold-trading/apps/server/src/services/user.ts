/**
 * User-scoped persistence: settings, watchlist, alerts, saved setups, journal.
 * Single-user local terminal — stored as JSON documents in DATA_DIR.
 */
import type { AssetId, JournalTrade, Timeframe, TradeSetup } from "@terminal/core";
import { JsonStore } from "../lib/store";

export interface UserSettings {
  timezone: string;
  theme: "dark" | "light" | "system";
  accountBalance: number;
  accountCurrency: string;
  defaultRiskPct: number;
  defaultTimeframe: Timeframe;
  followedAssets: AssetId[];
  followedTimeframes: Timeframe[];
  onboardingComplete: boolean;
  dashboardLayout: string[]; // ordered widget ids
  preferredInstrument: Record<string, string>; // assetClass -> spec id
  /** Automatically track every actionable setup for followed assets. */
  autoMonitorSetups: boolean;
}

export const DEFAULT_SETTINGS: UserSettings = {
  timezone: "UTC",
  theme: "dark",
  accountBalance: 10000,
  accountCurrency: "USD",
  defaultRiskPct: 1,
  defaultTimeframe: "4h",
  followedAssets: ["BTCUSD", "ETHUSD", "SOLUSD", "XAUUSD"],
  followedTimeframes: ["15m", "1h", "4h", "1d"],
  onboardingComplete: false,
  dashboardLayout: ["tickers", "chart", "regime", "conditions", "briefing", "watchlist", "events", "news"],
  preferredInstrument: { crypto: "binance-spot-BTCUSDT", gold: "xau-cfd-standard" },
  autoMonitorSetups: false,
};

export type AlertKind = "price_above" | "price_below" | "setup_status" | "regime_change" | "setup_monitor";

export interface AlertRule {
  id: string;
  kind: AlertKind;
  assetId: AssetId | null;
  timeframe?: Timeframe;
  level?: number;
  /** For setup alerts: minimum status strength (e.g. STRONG only). */
  statuses?: string[];
  note?: string;
  active: boolean;
  createdAt: number;
  lastTriggeredAt: number | null;
  triggerCount: number;
}

export interface TriggeredAlert {
  id: string;
  ruleId: string;
  kind: AlertKind;
  assetId: AssetId | null;
  message: string;
  value?: number;
  time: number;
  read: boolean;
}

export interface UserState {
  settings: UserSettings;
  watchlist: AssetId[];
  favorites: AssetId[];
  alerts: AlertRule[];
  triggered: TriggeredAlert[];
  savedSetups: TradeSetup[];
  savedAnalyses: { id: string; title: string; createdAt: number; payload: unknown }[];
}

export const userStore = new JsonStore<UserState>("user", () => ({ settings: DEFAULT_SETTINGS, watchlist: ["BTCUSD", "ETHUSD", "SOLUSD", "BNBUSD", "XRPUSD", "XAUUSD"], favorites: ["BTCUSD", "XAUUSD"], alerts: [], triggered: [], savedSetups: [], savedAnalyses: [] }));

export const journalStore = new JsonStore<{ trades: JournalTrade[] }>("journal", () => ({ trades: [] }));

/** Merge with defaults and migrate layouts saved by earlier builds (which used different widget ids). */
export function normalizeSettings(stored: Partial<UserSettings> | undefined): UserSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  const known = new Set(DEFAULT_SETTINGS.dashboardLayout);
  if (!Array.isArray(merged.dashboardLayout) || merged.dashboardLayout.length === 0 || merged.dashboardLayout.some((id) => !known.has(id))) merged.dashboardLayout = DEFAULT_SETTINGS.dashboardLayout;
  return merged;
}

export async function getSettings(): Promise<UserSettings> {
  const s = await userStore.load();
  return normalizeSettings(s.settings);
}

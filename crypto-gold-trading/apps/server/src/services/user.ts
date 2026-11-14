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
  followedAssets: ["BTCUSD", "ETHUSD", "SOLUSD", "XAUUSD", "XAGUSD"],
  followedTimeframes: ["15m", "1h", "4h", "1d"],
  onboardingComplete: false,
  dashboardLayout: ["tickers", "chart", "regime", "conditions", "briefing", "watchlist", "events", "news"],
  preferredInstrument: { crypto: "binance-spot-BTCUSDT", gold: "xau-cfd-standard", silver: "xag-cfd-standard" },
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
  /** One-time migrations already applied to this file (see applyUserMigrations). */
  migrations?: string[];
}

/** Silver was added after the first release: files written before that get it next to gold, once. */
const SILVER_MIGRATION = "add-silver";

export const userStore = new JsonStore<UserState>("user", () => ({ settings: DEFAULT_SETTINGS, watchlist: ["BTCUSD", "ETHUSD", "SOLUSD", "BNBUSD", "XRPUSD", "XAUUSD", "XAGUSD"], favorites: ["BTCUSD", "XAUUSD"], alerts: [], triggered: [], savedSetups: [], savedAnalyses: [], migrations: [SILVER_MIGRATION] }));

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

/** Silver goes right after gold in a list that holds gold; a list without gold is left as the user made it. */
export function withSilverNextToGold(list: AssetId[] | undefined): AssetId[] | undefined {
  if (!Array.isArray(list) || list.includes("XAGUSD") || !list.includes("XAUUSD")) return list;
  const out = [...list];
  out.splice(out.indexOf("XAUUSD") + 1, 0, "XAGUSD");
  return out;
}

/**
 * Brings a user file written by an earlier build up to date, once. Anyone who follows gold gets silver
 * next to it (ticker, setups, watchlist); the marker makes sure that removing it afterwards sticks.
 */
export function migrateUserState(state: UserState): { state: UserState; changed: boolean } {
  if (state.migrations?.includes(SILVER_MIGRATION)) return { state, changed: false };
  const settings = state.settings ? { ...state.settings, followedAssets: withSilverNextToGold(state.settings.followedAssets) ?? state.settings.followedAssets } : state.settings;
  return { state: { ...state, settings, watchlist: withSilverNextToGold(state.watchlist) ?? state.watchlist, migrations: [...(state.migrations ?? []), SILVER_MIGRATION] }, changed: true };
}

/** Run once at server start, before anything reads the settings. */
export async function applyUserMigrations(): Promise<void> {
  const { state, changed } = migrateUserState(await userStore.load());
  if (changed) await userStore.save(state);
}

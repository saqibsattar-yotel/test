import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import type { AssetId, Quote, Timeframe } from "@terminal/core";

export type Theme = "dark" | "light" | "system";
export type Upstream = "live" | "polling" | "demo" | "disconnected";

export interface Toast {
  id: string;
  title: string;
  body?: string;
  tone?: "neutral" | "bull" | "bear" | "warning";
  createdAt: number;
}

interface UiState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  timezone: string;
  setTimezone: (z: string) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  mobileNavOpen: boolean;
  setMobileNavOpen: (v: boolean) => void;
  commandOpen: boolean;
  setCommandOpen: (v: boolean) => void;
  alertsOpen: boolean;
  setAlertsOpen: (v: boolean) => void;
  helpOpen: boolean;
  setHelpOpen: (v: boolean) => void;
  selectedAsset: AssetId;
  setSelectedAsset: (a: AssetId) => void;
  selectedCrypto: AssetId;
  setSelectedCrypto: (a: AssetId) => void;
  selectedTimeframe: Timeframe;
  setSelectedTimeframe: (t: Timeframe) => void;
  quotes: Partial<Record<AssetId, Quote>>;
  upsertQuotes: (q: Quote[]) => void;
  upstream: Upstream;
  setUpstream: (u: Upstream) => void;
  toasts: Toast[];
  pushToast: (t: Omit<Toast, "id" | "createdAt">) => void;
  dismissToast: (id: string) => void;
  unreadAlerts: number;
  setUnreadAlerts: (n: number) => void;
  settingsVersion: number;
  bumpSettings: () => void;
}

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
      theme: "dark",
      setTheme: (theme) => set({ theme }),
      timezone: typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" : "UTC",
      setTimezone: (timezone) => set({ timezone }),
      sidebarCollapsed: false,
      toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
      mobileNavOpen: false,
      setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
      commandOpen: false,
      setCommandOpen: (commandOpen) => set({ commandOpen }),
      alertsOpen: false,
      setAlertsOpen: (alertsOpen) => set({ alertsOpen }),
      helpOpen: false,
      setHelpOpen: (helpOpen) => set({ helpOpen }),
      selectedAsset: "BTCUSD",
      setSelectedAsset: (selectedAsset) => set({ selectedAsset }),
      selectedCrypto: "BTCUSD",
      setSelectedCrypto: (selectedCrypto) => set({ selectedCrypto }),
      selectedTimeframe: "4h",
      setSelectedTimeframe: (selectedTimeframe) => set({ selectedTimeframe }),
      quotes: {},
      upsertQuotes: (list) =>
        set((s) => {
          const quotes = { ...s.quotes };
          for (const q of list) quotes[q.assetId] = q;
          return { quotes };
        }),
      upstream: "disconnected",
      setUpstream: (upstream) => set({ upstream }),
      toasts: [],
      pushToast: (t) => {
        const id = Math.random().toString(36).slice(2);
        set((s) => ({ toasts: [...s.toasts, { ...t, id, createdAt: Date.now() }].slice(-5) }));
        setTimeout(() => get().dismissToast(id), 7000);
      },
      dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
      unreadAlerts: 0,
      setUnreadAlerts: (unreadAlerts) => set({ unreadAlerts }),
      settingsVersion: 0,
      bumpSettings: () => set((s) => ({ settingsVersion: s.settingsVersion + 1 })),
    }),
    { name: "aurum-ui", partialize: (s) => ({ theme: s.theme, timezone: s.timezone, sidebarCollapsed: s.sidebarCollapsed, selectedAsset: s.selectedAsset, selectedCrypto: s.selectedCrypto, selectedTimeframe: s.selectedTimeframe }) },
  ),
);

/** Everything in the store except the high-frequency quote and toast slices. */
export const useUiNoQuotes = () =>
  useUi(
    useShallow((s) => {
      const { quotes: _quotes, toasts: _toasts, ...rest } = s;
      return rest;
    }),
  );

export function applyTheme(theme: Theme) {
  const resolved = theme === "system" ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : theme;
  document.documentElement.setAttribute("data-theme", resolved);
}

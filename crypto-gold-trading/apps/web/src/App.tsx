import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { SkeletonBlock } from "@/components/ui";
import { applyTheme, useUi } from "@/lib/store";
import { useMarketSocket } from "@/lib/ws";
import { useSettings } from "@/lib/queries";

const Overview = lazy(() => import("@/pages/Overview"));
const Crypto = lazy(() => import("@/pages/Crypto"));
const Gold = lazy(() => import("@/pages/Gold"));
const Setups = lazy(() => import("@/pages/Setups"));
const Technical = lazy(() => import("@/pages/Technical"));
const Intelligence = lazy(() => import("@/pages/Intelligence"));
const Risk = lazy(() => import("@/pages/Risk"));
const Journal = lazy(() => import("@/pages/Journal"));
const Performance = lazy(() => import("@/pages/Performance"));
const Settings = lazy(() => import("@/pages/Settings"));
const Backtest = lazy(() => import("@/pages/Backtest"));

function Fallback() {
  return (
    <div className="p-6 space-y-4">
      <SkeletonBlock lines={2} />
      <div className="grid gap-4 md:grid-cols-3">
        <div className="skeleton h-28" />
        <div className="skeleton h-28" />
        <div className="skeleton h-28" />
      </div>
      <div className="skeleton h-72" />
    </div>
  );
}

export default function App() {
  const theme = useUi((s) => s.theme);
  const setTimezone = useUi((s) => s.setTimezone);
  const setTheme = useUi((s) => s.setTheme);
  useMarketSocket();
  const settings = useSettings();
  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const h = () => applyTheme("system");
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [theme]);
  // Server-side settings are the source of truth for timezone/theme once loaded.
  useEffect(() => {
    const s = settings.data?.settings;
    if (!s) return;
    if (s.timezone) setTimezone(s.timezone);
    if (s.theme) setTheme(s.theme);
  }, [settings.data, setTimezone, setTheme]);
  return (
    <AppShell>
      <Suspense fallback={<Fallback />}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/crypto" element={<Crypto />} />
          <Route path="/gold" element={<Gold />} />
          <Route path="/setups" element={<Setups />} />
          <Route path="/technical" element={<Technical />} />
          <Route path="/intelligence" element={<Intelligence />} />
          <Route path="/risk" element={<Risk />} />
          <Route path="/journal" element={<Journal />} />
          <Route path="/performance" element={<Performance />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/backtest" element={<Backtest />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

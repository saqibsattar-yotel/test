import { useEffect, useMemo, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Bell, ChevronsLeft, ChevronsRight, HelpCircle, Menu, Moon, MoreHorizontal, Search, Sun, X } from "lucide-react";
import { assetBase, zoneAbbreviation, type AssetId } from "@terminal/core";
import { Badge, Dot, IconButton, Kbd, Modal, Toasts, Tooltip } from "@/components/ui";
import { useUi, useUiNoQuotes } from "@/lib/store";
import { cls, fmtPct, fmtPrice, fmtTime, toneForChange } from "@/lib/format";
import { useAlerts, useSettings } from "@/lib/queries";
import { assetTextClass, isMetalAsset, workspacePath } from "@/lib/metals";
import { NAV } from "./nav";
import { CommandPalette } from "./CommandPalette";
import { AlertsDrawer } from "./AlertsDrawer";
import { Onboarding } from "./Onboarding";
import { FirstStartNotice } from "./FirstStartNotice";

function useClock(zone: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return { time: fmtTime(now, zone, true), abbr: zoneAbbreviation(now, zone) };
}

function useShortcuts() {
  const navigate = useNavigate();
  useEffect(() => {
    let pendingG = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ui.setCommandOpen(!ui.commandOpen);
        return;
      }
      if (e.key === "Escape") {
        ui.setCommandOpen(false);
        ui.setAlertsOpen(false);
        ui.setHelpOpen(false);
        ui.setMobileNavOpen(false);
        return;
      }
      if (typing) return;
      if (e.key === "?") {
        ui.setHelpOpen(true);
        return;
      }
      if (pendingG) {
        pendingG = false;
        const item = NAV.find((n) => n.key === e.key);
        if (item) {
          e.preventDefault();
          navigate(item.to);
        }
        return;
      }
      if (e.key === "g") {
        pendingG = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => (pendingG = false), 1200);
        return;
      }
      if (e.key === "t") ui.setTheme(ui.theme === "dark" ? "light" : "dark");
      if (e.key === "/") {
        e.preventDefault();
        ui.setCommandOpen(true);
      }
      if (e.key === "a") ui.setAlertsOpen(!ui.alertsOpen);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
}

export function AppShell({ children }: { children: ReactNode }) {
  const ui = useUiNoQuotes();
  const loc = useLocation();
  const settings = useSettings();
  const alerts = useAlerts();
  useShortcuts();
  const clock = useClock(ui.timezone);
  const unread = alerts.data?.triggered.filter((t) => !t.read).length ?? ui.unreadAlerts;
  const current = NAV.find((n) => n.to === loc.pathname) ?? NAV[0];
  const followed = useMemo<AssetId[]>(() => settings.data?.settings.followedAssets ?? ["BTCUSD", "ETHUSD", "SOLUSD", "XAUUSD", "XAGUSD"], [settings.data]);
  const mobileNav = NAV.filter((n) => n.mobile);
  useEffect(() => {
    document.title = `${current.label} · Aurum Terminal`;
  }, [current]);
  const collapsed = ui.sidebarCollapsed;
  const upstreamTone = ui.upstream === "live" ? "bull" : ui.upstream === "polling" ? "warning" : ui.upstream === "demo" ? "bear" : "muted";
  const upstreamLabel = ui.upstream === "live" ? "Live stream" : ui.upstream === "polling" ? "Polling (stream unavailable)" : ui.upstream === "demo" ? "DEMO data" : "Disconnected";

  return (
    <div className="min-h-full flex">
      <aside className={cls("hidden md:flex flex-col shrink-0 sticky top-0 h-screen border-r border-line bg-surface-1 transition-[width] duration-200", collapsed ? "w-[64px]" : "w-[232px]")}>
        <div className={cls("flex items-center gap-2.5 h-14 px-4 border-b border-line", collapsed && "justify-center px-0")}>
          <Brand />
          {!collapsed && (
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight text-ink-1">Aurum Terminal</div>
              <div className="text-[10.5px] text-ink-3">Crypto, gold & silver research</div>
            </div>
          )}
        </div>
        <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"} className={({ isActive }) => cls("flex items-center gap-3 rounded-lg px-2.5 h-9 text-sm transition-colors", isActive ? "bg-surface-3 text-ink-1 font-medium" : "text-ink-2 hover:bg-surface-2 hover:text-ink-1", collapsed && "justify-center px-0")} title={collapsed ? n.label : undefined}>
              <n.icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">{n.label}</span>}
              {!collapsed && <span className="ml-auto pl-1 shrink-0 whitespace-nowrap text-[10px] text-ink-3 hidden lg:inline">g {n.key}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="p-2 border-t border-line">
          <button onClick={ui.toggleSidebar} className="w-full h-9 flex items-center justify-center gap-2 rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink-1 text-xs" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
            {!collapsed && "Collapse"}
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-40 h-14 border-b border-line bg-page/85 backdrop-blur flex items-center gap-3 px-3 sm:px-4">
          <IconButton label="Menu" className="md:hidden" onClick={() => ui.setMobileNavOpen(true)}>
            <Menu className="h-5 w-5" />
          </IconButton>
          <div className="md:hidden flex items-center gap-2">
            <Brand small />
            <span className="text-sm font-semibold text-ink-1 truncate">{current.short}</span>
          </div>
          <div className="hidden md:flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
            <TickerStrip assets={followed} />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button onClick={() => ui.setCommandOpen(true)} className="hidden sm:inline-flex items-center gap-2 h-9 rounded-lg border border-line bg-surface-1 px-3 text-xs text-ink-3 hover:text-ink-1 hover:bg-surface-2">
              <Search className="h-3.5 w-3.5" />
              <span>Search / jump</span>
              <Kbd>⌘K</Kbd>
            </button>
            <IconButton label="Search" className="sm:hidden" onClick={() => ui.setCommandOpen(true)}>
              <Search className="h-4 w-4" />
            </IconButton>
            <Tooltip content={`${upstreamLabel} · ${ui.timezone}`}>
              <span className="hidden sm:inline-flex items-center gap-2 h-9 rounded-lg border border-line bg-surface-1 px-3 text-xs text-ink-2 cursor-help">
                <Dot tone={upstreamTone} pulse={ui.upstream === "live"} />
                <span className="tabular font-medium text-ink-1">{clock.time}</span>
                <span className="text-ink-3">{clock.abbr}</span>
              </span>
            </Tooltip>
            <IconButton label="Toggle theme" onClick={() => ui.setTheme(ui.theme === "dark" ? "light" : "dark")}>
              {ui.theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </IconButton>
            <IconButton label="Alerts" onClick={() => ui.setAlertsOpen(true)} className="relative">
              <Bell className="h-4 w-4" />
              {unread > 0 && <span className="absolute top-1 right-1 h-4 min-w-4 px-1 rounded-full bg-bear text-[10px] font-semibold text-white flex items-center justify-center">{unread > 9 ? "9+" : unread}</span>}
            </IconButton>
            <IconButton label="Keyboard shortcuts" onClick={() => ui.setHelpOpen(true)} className="hidden sm:inline-flex">
              <HelpCircle className="h-4 w-4" />
            </IconButton>
          </div>
        </header>
        <FirstStartNotice />

        <main className="flex-1 w-full max-w-[1680px] mx-auto px-3 sm:px-4 lg:px-6 py-4 lg:py-6 pb-24 md:pb-8 min-w-0">{children}</main>

        <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-line bg-surface-1/95 backdrop-blur safe-bottom">
          <div className="grid" style={{ gridTemplateColumns: `repeat(${mobileNav.length + 1}, minmax(0, 1fr))` }}>
            {mobileNav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === "/"} className={({ isActive }) => cls("flex flex-col items-center justify-center gap-0.5 h-14 text-[10.5px]", isActive ? "text-accent" : "text-ink-3")}>
                <n.icon className="h-5 w-5" />
                {n.short}
              </NavLink>
            ))}
            <button onClick={() => ui.setMobileNavOpen(true)} className={cls("flex flex-col items-center justify-center gap-0.5 h-14 text-[10.5px]", NAV.filter((n) => !n.mobile).some((n) => n.to === loc.pathname) ? "text-accent" : "text-ink-3")}>
              <MoreHorizontal className="h-5 w-5" />
              More
            </button>
          </div>
        </nav>
      </div>

      {ui.mobileNavOpen && (
        <div className="fixed inset-0 z-[70] md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => ui.setMobileNavOpen(false)} />
          <div className="absolute bottom-0 inset-x-0 card rounded-b-none p-3 safe-bottom fade-in">
            <div className="flex items-center justify-between px-1 pb-2">
              <span className="text-sm font-semibold">Navigate</span>
              <IconButton label="Close" onClick={() => ui.setMobileNavOpen(false)}>
                <X className="h-4 w-4" />
              </IconButton>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {NAV.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.to === "/"} onClick={() => ui.setMobileNavOpen(false)} className={({ isActive }) => cls("flex items-center gap-2.5 rounded-lg px-3 h-11 text-sm", isActive ? "bg-surface-3 text-ink-1" : "text-ink-2 bg-surface-2")}>
                  <n.icon className="h-4 w-4" />
                  {n.label}
                </NavLink>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-ink-3 px-1">
              <span className="flex items-center gap-2">
                <Dot tone={upstreamTone} /> {upstreamLabel}
              </span>
              <span className="tabular">
                {clock.time} {clock.abbr}
              </span>
            </div>
          </div>
        </div>
      )}

      <CommandPalette />
      <AlertsDrawer />
      <ShortcutsHelp />
      <Onboarding />
      <Toasts />
    </div>
  );
}

function Brand({ small }: { small?: boolean }) {
  return (
    <svg viewBox="0 0 32 32" className={cls(small ? "h-7 w-7" : "h-8 w-8", "shrink-0")} aria-hidden>
      <rect width="32" height="32" rx="7" fill="var(--surface-3)" />
      <path d="M7 22 L13 10 L19 22" fill="none" stroke="var(--gold)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18 17 L25 17" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M20 22 L25 12" stroke="var(--bull)" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function TickerStrip({ assets }: { assets: AssetId[] }) {
  const quotes = useUi((s) => s.quotes);
  const navigate = useNavigate();
  const setSelected = useUi((s) => s.setSelectedAsset);
  const setCrypto = useUi((s) => s.setSelectedCrypto);
  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      {assets.map((a) => {
        const q = quotes[a];
        const tone = toneForChange(q?.changePct24h);
        return (
          <button
            key={a}
            onClick={() => {
              if (!isMetalAsset(a)) setCrypto(a);
              navigate(workspacePath(a));
              setSelected(a);
            }}
            className="flex items-center gap-2 h-9 rounded-lg px-2.5 hover:bg-surface-2 text-xs whitespace-nowrap"
          >
            <span className={cls("font-semibold", assetTextClass(a))}>{assetBase(a)}</span>
            <span className="tabular text-ink-1">{q ? fmtPrice(q.price, a) : "—"}</span>
            <span className={cls("tabular", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-ink-3")}>{q ? fmtPct(q.changePct24h) : ""}</span>
            {q?.source.quality === "demo" && (
              <Badge tone="bear" size="sm">
                DEMO
              </Badge>
            )}
            {q?.source.proxy && (
              <Badge tone="gold" size="sm">
                proxy
              </Badge>
            )}
          </button>
        );
      })}
    </div>
  );
}

function ShortcutsHelp() {
  const open = useUi((s) => s.helpOpen);
  const setOpen = useUi((s) => s.setHelpOpen);
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts">
      <div className="grid sm:grid-cols-2 gap-x-8 gap-y-2 text-sm">
        {NAV.map((n) => (
          <div key={n.to} className="flex items-center justify-between py-1">
            <span className="text-ink-2">{n.label}</span>
            <span className="flex gap-1">
              <Kbd>g</Kbd>
              <Kbd>{n.key}</Kbd>
            </span>
          </div>
        ))}
        <div className="flex items-center justify-between py-1">
          <span className="text-ink-2">Search / jump to</span>
          <span className="flex gap-1">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </div>
        <div className="flex items-center justify-between py-1">
          <span className="text-ink-2">Toggle theme</span>
          <Kbd>t</Kbd>
        </div>
        <div className="flex items-center justify-between py-1">
          <span className="text-ink-2">Alerts</span>
          <Kbd>a</Kbd>
        </div>
        <div className="flex items-center justify-between py-1">
          <span className="text-ink-2">This help</span>
          <Kbd>?</Kbd>
        </div>
      </div>
    </Modal>
  );
}

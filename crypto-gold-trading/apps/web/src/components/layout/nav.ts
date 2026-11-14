import { Activity, BarChart3, Bitcoin, BookOpen, Calculator, Coins, Disc, FlaskConical, Globe2, LayoutDashboard, Settings, Target, type LucideIcon } from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  short: string;
  icon: LucideIcon;
  key: string; // "g" + key shortcut
  mobile?: boolean;
}

export const NAV: NavItem[] = [
  { to: "/", label: "Overview", short: "Home", icon: LayoutDashboard, key: "o", mobile: true },
  { to: "/crypto", label: "Crypto Analysis", short: "Crypto", icon: Bitcoin, key: "c", mobile: true },
  { to: "/gold", label: "Gold Analysis", short: "Gold", icon: Coins, key: "g", mobile: true },
  { to: "/silver", label: "Silver Analysis", short: "Silver", icon: Disc, key: "v", mobile: true },
  { to: "/setups", label: "AI Trade Setups", short: "Setups", icon: Target, key: "s", mobile: true },
  { to: "/technical", label: "Technical Analysis", short: "Technical", icon: Activity, key: "t" },
  { to: "/intelligence", label: "Market Intelligence", short: "Intel", icon: Globe2, key: "i" },
  { to: "/risk", label: "Risk Calculator", short: "Risk", icon: Calculator, key: "r" },
  { to: "/journal", label: "Trade Journal", short: "Journal", icon: BookOpen, key: "j" },
  { to: "/performance", label: "Performance Analytics", short: "Performance", icon: BarChart3, key: "p" },
  { to: "/backtest", label: "Backtesting", short: "Backtest", icon: FlaskConical, key: "b" },
  { to: "/settings", label: "Settings", short: "Settings", icon: Settings, key: "," },
];

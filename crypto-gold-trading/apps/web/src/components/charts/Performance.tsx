import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis, ReferenceLine } from "recharts";
import type { EquityPoint } from "@terminal/core";
import { fmtCompact, fmtDate, fmtMoney } from "@/lib/format";
import { useUi } from "@/lib/store";

const tooltipStyle = { background: "var(--surface-3)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12, color: "var(--ink-1)" };

export function EquityCurve({ points, currency = "USD", height = 240 }: { points: EquityPoint[]; currency?: string; height?: number }) {
  const tz = useUi((s) => s.timezone);
  if (points.length < 2) return <p className="text-xs text-ink-3">Record at least two closed trades to draw an equity curve.</p>;
  const data = points.map((p) => ({ time: p.time, equity: p.equity, drawdown: -p.drawdown }));
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.18} />
              <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="time" tickFormatter={(t) => fmtDate(t, tz)} stroke="var(--axis)" tick={{ fill: "var(--ink-3)", fontSize: 11 }} minTickGap={40} />
          <YAxis tickFormatter={(v) => fmtCompact(v)} stroke="var(--axis)" tick={{ fill: "var(--ink-3)", fontSize: 11 }} width={56} domain={["auto", "auto"]} />
          <RTooltip contentStyle={tooltipStyle} labelFormatter={(t) => fmtDate(Number(t), tz)} formatter={(v: number, name: string) => [fmtMoney(name === "drawdown" ? -v : v, currency), name === "drawdown" ? "Drawdown" : "Equity"]} />
          <Area type="monotone" dataKey="equity" stroke="var(--series-1)" strokeWidth={2} fill="url(#eq)" dot={false} activeDot={{ r: 4, stroke: "var(--surface-1)", strokeWidth: 2 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MonthlyBars({ monthly, currency = "USD", height = 220 }: { monthly: { month: string; pnl: number; trades: number; winRate: number }[]; currency?: string; height?: number }) {
  if (!monthly.length) return <p className="text-xs text-ink-3">No closed trades yet.</p>;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={monthly} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="30%">
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="month" stroke="var(--axis)" tick={{ fill: "var(--ink-3)", fontSize: 11 }} />
          <YAxis tickFormatter={(v) => fmtCompact(v)} stroke="var(--axis)" tick={{ fill: "var(--ink-3)", fontSize: 11 }} width={56} />
          <ReferenceLine y={0} stroke="var(--axis)" />
          <RTooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--surface-3)", opacity: 0.4 }} formatter={(v: number, _n, p) => [`${fmtMoney(v, currency)} · ${(p.payload as { trades: number }).trades} trades · ${(p.payload as { winRate: number }).winRate.toFixed(0)}% win`, "P&L"]} />
          <Bar dataKey="pnl" radius={[4, 4, 0, 0]} maxBarSize={24}>
            {monthly.map((m) => (
              <Cell key={m.month} fill={m.pnl >= 0 ? "var(--bull)" : "var(--bear)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function HBarList({ rows, valueFormatter, max }: { rows: { key: string; value: number; label?: string }[]; valueFormatter?: (v: number) => string; max?: number }) {
  const m = max ?? Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[110px_1fr_auto] items-center gap-2 text-xs">
          <span className="truncate text-ink-2">{r.label ?? r.key}</span>
          <div className="h-2 rounded-full bg-surface-3 overflow-hidden flex">
            <div className="h-full rounded-full" style={{ width: `${(Math.abs(r.value) / m) * 100}%`, background: r.value >= 0 ? "var(--bull)" : "var(--bear)" }} />
          </div>
          <span className={`tabular font-medium ${r.value >= 0 ? "text-bull" : "text-bear"}`}>{valueFormatter ? valueFormatter(r.value) : r.value.toFixed(2)}</span>
        </li>
      ))}
    </ul>
  );
}

export function LiquidationTimeline({ timeline, height = 160 }: { timeline: { time: number; longUsd: number; shortUsd: number }[]; height?: number }) {
  const tz = useUi((s) => s.timezone);
  if (!timeline.length) return <p className="text-xs text-ink-3">No liquidation events observed yet since the server started.</p>;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={timeline} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="time" tickFormatter={(t) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t))} stroke="var(--axis)" tick={{ fill: "var(--ink-3)", fontSize: 11 }} />
          <YAxis tickFormatter={(v) => fmtCompact(v)} stroke="var(--axis)" tick={{ fill: "var(--ink-3)", fontSize: 11 }} width={48} />
          <RTooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--surface-3)", opacity: 0.4 }} formatter={(v: number, name: string) => [fmtMoney(v, "USD", 0), name === "longUsd" ? "Longs liquidated" : "Shorts liquidated"]} labelFormatter={(t) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(Number(t)))} />
          <Bar dataKey="longUsd" stackId="a" fill="var(--bear)" maxBarSize={24} />
          <Bar dataKey="shortUsd" stackId="a" fill="var(--bull)" radius={[4, 4, 0, 0]} maxBarSize={24} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

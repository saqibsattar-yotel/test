import { useEffect, useId, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ChevronDown, Info, Loader2, RefreshCw, X } from "lucide-react";
import type { DataSource } from "@terminal/core";
import { cls, fmtAge, fmtTime, qualityLabel } from "@/lib/format";
import { useUi } from "@/lib/store";

export type Tone = "neutral" | "bull" | "bear" | "gold" | "accent" | "warning" | "critical" | "muted";

const toneBadge: Record<Tone, string> = {
  neutral: "bg-surface-3 text-ink-2 border-line",
  bull: "bg-bull-soft text-bull border-transparent",
  bear: "bg-bear-soft text-bear border-transparent",
  gold: "bg-gold-soft text-gold border-transparent",
  accent: "bg-accent-soft text-accent border-transparent",
  warning: "text-warn border-transparent",
  critical: "text-crit border-transparent",
  muted: "bg-surface-2 text-ink-3 border-line",
};

export function Badge({ tone = "neutral", children, className, size = "md", title }: { tone?: Tone; children: ReactNode; className?: string; size?: "sm" | "md"; title?: string }) {
  return (
    <span title={title} className={cls("inline-flex items-center gap-1 rounded-md border font-medium whitespace-nowrap", size === "sm" ? "px-1.5 py-0 text-[10.5px] leading-5" : "px-2 py-0.5 text-xs", tone === "warning" ? "bg-[rgba(250,178,25,0.14)]" : tone === "critical" ? "bg-[rgba(208,59,59,0.16)]" : "", toneBadge[tone], className)}>
      {children}
    </span>
  );
}

export function Dot({ tone = "neutral", pulse = false }: { tone?: Tone; pulse?: boolean }) {
  const color = tone === "bull" ? "var(--bull)" : tone === "bear" ? "var(--bear)" : tone === "gold" ? "var(--gold)" : tone === "warning" ? "var(--warning)" : tone === "critical" ? "var(--critical)" : tone === "accent" ? "var(--accent)" : "var(--ink-3)";
  return <span aria-hidden className={cls("inline-block h-2 w-2 rounded-full", pulse && "animate-pulse")} style={{ background: color }} />;
}

export function Button({ variant = "secondary", size = "md", loading, icon, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" | "gold"; size?: "sm" | "md" | "lg"; loading?: boolean; icon?: ReactNode }) {
  const base = "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed select-none";
  const sizes = { sm: "h-8 px-2.5 text-xs", md: "h-9 px-3.5 text-sm", lg: "h-11 px-5 text-sm" }[size];
  const variants = {
    primary: "bg-accent text-white hover:brightness-110",
    secondary: "bg-surface-2 border border-line text-ink-1 hover:bg-surface-3",
    ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink-1",
    danger: "bg-bear-soft text-bear border border-transparent hover:brightness-110",
    gold: "bg-gold text-[#0b1220] hover:brightness-110",
  }[variant];
  return (
    <button className={cls(base, sizes, variants, className)} disabled={loading || rest.disabled} {...rest}>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button aria-label={label} title={label} className={cls("inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink-1 transition-colors", active && "bg-surface-2 text-ink-1", className)} {...rest}>
      {children}
    </button>
  );
}

export function Card({ title, subtitle, actions, children, className, source, footer, padded = true, loading, error, onRetry, id }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; source?: DataSource | DataSource[] | null; footer?: ReactNode; padded?: boolean; loading?: boolean; error?: string | null; onRetry?: () => void; id?: string }) {
  const sources = Array.isArray(source) ? source : source ? [source] : [];
  return (
    <section id={id} className={cls("card flex flex-col min-w-0", className)}>
      {(title || actions || sources.length > 0) && (
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 pt-3.5 pb-2.5 border-b border-line">
          <div className="min-w-0 flex-1 basis-40">
            {title && <h2 className="text-[13px] font-semibold tracking-wide text-ink-1 truncate">{title}</h2>}
            {subtitle && <p className="text-xs text-ink-3 mt-0.5 truncate">{subtitle}</p>}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 max-w-full">
            {sources.slice(0, 3).map((s, i) => (
              <SourceBadge key={i} source={s} compact />
            ))}
            {sources.length > 3 && <span className="text-[10.5px] text-ink-3">+{sources.length - 3} sources</span>}
            {actions}
          </div>
        </header>
      )}
      <div className={cls("flex-1 min-w-0", padded && "p-4")}>
        {loading ? <SkeletonBlock lines={4} /> : error ? <ErrorState message={error} retry={onRetry} compact /> : children}
      </div>
      {footer && <footer className="px-4 py-2.5 border-t border-line text-xs text-ink-3">{footer}</footer>}
    </section>
  );
}

export function SourceBadge({ source, compact = false }: { source: DataSource; compact?: boolean }) {
  const tz = useUi((s) => s.timezone);
  const q = qualityLabel(source);
  const tip = `${source.label}\nAs of ${fmtTime(source.asOf, tz, true)} (${fmtAge(source.asOf)}) · fetched ${fmtAge(source.fetchedAt)}${source.note ? `\n${source.note}` : ""}`;
  return (
    <Tooltip content={<pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed">{tip}</pre>}>
      <span className={cls("inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 text-ink-3 cursor-help", compact ? "px-1.5 py-0.5 text-[10.5px]" : "px-2 py-1 text-xs")}>
        <Dot tone={q.tone} pulse={source.quality === "live"} />
        <span className={cls("font-medium", q.tone === "bear" && "text-bear", q.tone === "gold" && "text-gold", q.tone === "warning" && "text-warn")}>{q.label}</span>
        {!compact && <span className="text-ink-3">· {source.provider}</span>}
        <span className="tabular">{fmtTime(source.asOf, tz)}</span>
      </span>
    </Tooltip>
  );
}

export function DataNotice({ sources, warnings, className }: { sources?: (DataSource | null | undefined)[]; warnings?: string[]; className?: string }) {
  const list = (sources ?? []).filter((s): s is DataSource => !!s);
  const demo = list.filter((s) => s.quality === "demo");
  const proxy = list.filter((s) => s.proxy);
  const stale = list.filter((s) => s.quality === "stale" || s.quality === "delayed");
  const items: { tone: Tone; text: string }[] = [];
  if (demo.length) items.push({ tone: "bear", text: `DEMO DATA — ${demo[0].note ?? "synthetic values, not real prices"}` });
  if (proxy.length) items.push({ tone: "gold", text: `PROXY — ${proxy[0].label}. ${proxy[0].note ?? ""}` });
  if (stale.length) items.push({ tone: "warning", text: `Stale/delayed data — last update ${fmtAge(stale[0].asOf)}.` });
  for (const w of warnings ?? []) items.push({ tone: "warning", text: w });
  if (!items.length) return null;
  return (
    <div className={cls("flex flex-col gap-1.5", className)}>
      {items.map((it, i) => (
        <div key={i} className={cls("flex items-start gap-2 rounded-lg px-3 py-2 text-xs", it.tone === "bear" ? "bg-bear-soft text-bear" : it.tone === "gold" ? "bg-gold-soft text-gold" : "bg-[rgba(250,178,25,0.12)] text-warn")}>
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{it.text}</span>
        </div>
      ))}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cls("skeleton", className)} aria-hidden />;
}
export function SkeletonBlock({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2.5" aria-busy>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cls("h-3.5", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, description, action, compact }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={cls("flex flex-col items-center justify-center text-center", compact ? "py-6" : "py-12")}>
      <div className="h-10 w-10 rounded-full bg-surface-2 border border-line flex items-center justify-center text-ink-3 mb-3">{icon ?? <Info className="h-5 w-5" />}</div>
      <p className="text-sm font-medium text-ink-1">{title}</p>
      {description && <p className="text-xs text-ink-3 mt-1 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = "Could not load data", message, retry, compact }: { title?: string; message?: string; retry?: () => void; compact?: boolean }) {
  return (
    <div className={cls("flex flex-col items-center justify-center text-center", compact ? "py-6" : "py-12")} role="alert">
      <div className="h-10 w-10 rounded-full bg-bear-soft flex items-center justify-center text-bear mb-3">
        <AlertTriangle className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium text-ink-1">{title}</p>
      {message && <p className="text-xs text-ink-3 mt-1 max-w-md break-words">{message}</p>}
      {retry && (
        <Button size="sm" className="mt-4" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: r.left + r.width / 2, y: side === "top" ? r.top : r.bottom });
    setOpen(true);
  };
  return (
    <span ref={ref} className="inline-flex" onMouseEnter={show} onMouseLeave={() => setOpen(false)} onFocus={show} onBlur={() => setOpen(false)}>
      {children}
      {open &&
        pos &&
        createPortal(
          <div role="tooltip" className="fixed z-[100] max-w-xs rounded-lg border border-line bg-surface-3 px-3 py-2 text-xs text-ink-1 shadow-xl pointer-events-none fade-in" style={{ left: Math.min(Math.max(8, pos.x), window.innerWidth - 8), top: side === "top" ? pos.y - 8 : pos.y + 8, transform: side === "top" ? "translate(-50%, -100%)" : "translate(-50%, 0)" }}>
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}

export function HelpTip({ text }: { text: string }) {
  return (
    <Tooltip content={text}>
      <Info className="h-3.5 w-3.5 text-ink-3 cursor-help" />
    </Tooltip>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cls("flex flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-ink-2 flex items-center gap-1.5">
        {label}
        {hint && <HelpTip text={hint} />}
      </span>
      {children}
    </label>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cls("h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink-1 placeholder:text-ink-3 focus:border-accent", rest.type === "number" && "tabular", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select className={cls("h-9 w-full appearance-none rounded-lg border border-line bg-surface-2 pl-3 pr-8 text-sm text-ink-1 focus:border-accent", className)} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-3" />
    </div>
  );
}

export function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label?: string; description?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex items-center justify-between gap-4 w-full text-left">
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className="block text-sm text-ink-1">{label}</span>}
          {description && <span className="block text-xs text-ink-3">{description}</span>}
        </span>
      )}
      <span className={cls("relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-accent" : "bg-surface-3 border border-line")}>
        <span className={cls("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform", checked ? "translate-x-4" : "translate-x-0.5")} />
      </span>
    </button>
  );
}

export function Segmented<T extends string>({ options, value, onChange, size = "md", className }: { options: { value: T; label: ReactNode; disabled?: boolean }[]; value: T; onChange: (v: T) => void; size?: "sm" | "md"; className?: string }) {
  return (
    <div role="tablist" className={cls("inline-flex rounded-lg bg-surface-2 border border-line p-0.5", className)}>
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} disabled={o.disabled} onClick={() => onChange(o.value)} className={cls("rounded-md font-medium transition-colors whitespace-nowrap", size === "sm" ? "px-2 h-7 text-xs" : "px-3 h-8 text-sm", o.value === value ? "bg-surface-3 text-ink-1 shadow-sm" : "text-ink-3 hover:text-ink-1", o.disabled && "opacity-40")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { value: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-line overflow-x-auto">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={t.value === value} onClick={() => onChange(t.value)} className={cls("relative px-3 h-10 text-sm font-medium whitespace-nowrap transition-colors", t.value === value ? "text-ink-1" : "text-ink-3 hover:text-ink-2")}>
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 text-xs text-ink-3 tabular">{t.count}</span>}
          {t.value === value && <span className="absolute left-2 right-2 -bottom-px h-0.5 bg-accent rounded-full" />}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-0 sm:p-6" role="dialog" aria-modal aria-labelledby={titleId}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <div className={cls("relative w-full card shadow-2xl max-h-[92vh] flex flex-col fade-in rounded-b-none sm:rounded-xl", wide ? "sm:max-w-4xl" : "sm:max-w-xl")}>
        <header className="flex items-center justify-between px-5 py-3.5 border-b border-line">
          <h2 id={titleId} className="text-sm font-semibold text-ink-1">
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </header>
        <div className="p-5 overflow-y-auto">{children}</div>
        {footer && <footer className="px-5 py-3.5 border-t border-line flex items-center justify-end gap-2 safe-bottom">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, children, width = "max-w-2xl" }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[80]" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside className={cls("absolute right-0 top-0 h-full w-full bg-surface-1 border-l border-line shadow-2xl flex flex-col fade-in", width)}>
        <header className="flex items-center justify-between px-5 py-3.5 border-b border-line shrink-0">
          <h2 className="text-sm font-semibold text-ink-1">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </header>
        <div className="flex-1 overflow-y-auto p-5 safe-bottom">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}

export function Stat({ label, value, delta, deltaTone, hint, sub, children, className, big }: { label: ReactNode; value: ReactNode; delta?: ReactNode; deltaTone?: Tone; hint?: string; sub?: ReactNode; children?: ReactNode; className?: string; big?: boolean }) {
  return (
    <div className={cls("card px-4 py-3.5 flex flex-col gap-1 min-w-0", className)}>
      <div className="flex items-start gap-1.5 text-xs text-ink-3 leading-snug">
        <span>{label}</span>
        {hint && <HelpTip text={hint} />}
      </div>
      <div className="flex items-baseline gap-x-2 gap-y-0.5 min-w-0 flex-wrap">
        <span className={cls("font-semibold text-ink-1 truncate max-w-full", big ? "text-2xl" : "text-lg")} title={typeof value === "string" ? value : undefined}>
          {value}
        </span>
        {delta !== undefined && <span className={cls("text-xs font-medium tabular", deltaTone === "bull" ? "text-bull" : deltaTone === "bear" ? "text-bear" : deltaTone === "gold" ? "text-gold" : "text-ink-3")}>{delta}</span>}
      </div>
      {sub && <div className="text-xs text-ink-3 truncate">{sub}</div>}
      {children && <div className="flex items-center justify-end pt-0.5">{children}</div>}
    </div>
  );
}

/** Meter: fill carries severity; track is a lighter step of the same ramp. */
export function Meter({ value, max = 100, tone = "accent", label, className, thresholds }: { value: number | null; max?: number; tone?: Tone; label?: string; className?: string; thresholds?: { at: number; label: string }[] }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const color = tone === "bull" ? "var(--bull)" : tone === "bear" ? "var(--bear)" : tone === "gold" ? "var(--gold)" : tone === "warning" ? "var(--warning)" : "var(--accent)";
  return (
    <div className={cls("w-full", className)} role="meter" aria-valuenow={value ?? undefined} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
      <div className="relative h-2.5 w-full rounded-full overflow-hidden" style={{ background: `color-mix(in oklab, ${color} 18%, var(--surface-3))` }}>
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: color }} />
        {thresholds?.map((t) => (
          <span key={t.at} className="absolute top-0 h-full w-px bg-page/70" style={{ left: `${(t.at / max) * 100}%` }} title={t.label} />
        ))}
      </div>
    </div>
  );
}

export function Sparkline({ values, width = 96, height = 28, tone = "accent", className, baseline }: { values: number[]; width?: number; height?: number; tone?: Tone | "auto"; className?: string; baseline?: number }) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return <svg width={width} height={height} className={className} aria-hidden />;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min || 1;
  const pts = clean.map((v, i) => [(i / (clean.length - 1)) * (width - 2) + 1, height - 2 - ((v - min) / range) * (height - 4)] as const);
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const resolved = tone === "auto" ? (clean[clean.length - 1] >= (baseline ?? clean[0]) ? "bull" : "bear") : tone;
  const color = resolved === "bull" ? "var(--bull)" : resolved === "bear" ? "var(--bear)" : resolved === "gold" ? "var(--gold)" : resolved === "muted" ? "var(--ink-3)" : "var(--accent)";
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      <path d={`${d} L${last[0]},${height} L${pts[0][0]},${height} Z`} fill={color} opacity={0.1} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill={color} stroke="var(--surface-1)" strokeWidth={1.5} />
    </svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-surface-2 px-1.5 text-[10.5px] font-medium text-ink-2">{children}</kbd>;
}

export function Checkmark({ ok }: { ok: boolean | null }) {
  if (ok === null) return <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-surface-3 text-ink-3 text-xs">?</span>;
  return ok ? (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-bull-soft text-bull">
      <Check className="h-3 w-3" />
    </span>
  ) : (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-bear-soft text-bear">
      <X className="h-3 w-3" />
    </span>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  if (!toasts.length) return null;
  return createPortal(
    <div className="fixed bottom-20 sm:bottom-6 right-4 z-[95] flex flex-col gap-2 w-[min(92vw,360px)]" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cls("card shadow-2xl px-4 py-3 flex items-start gap-3 fade-in border-l-2", t.tone === "bull" ? "border-l-bull" : t.tone === "bear" ? "border-l-bear" : t.tone === "warning" ? "border-l-warn" : "border-l-accent")}>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink-1">{t.title}</p>
            {t.body && <p className="text-xs text-ink-2 mt-0.5 break-words">{t.body}</p>}
          </div>
          <button aria-label="Dismiss" className="text-ink-3 hover:text-ink-1" onClick={() => dismiss(t.id)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-1 tracking-tight">{title}</h1>
        {description && <p className="text-sm text-ink-3 mt-1 max-w-3xl">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

export function Disclaimer({ className }: { className?: string }) {
  return <p className={cls("text-[11px] leading-relaxed text-ink-3", className)}>Research output for human review. Nothing here is financial advice, a signal service, or an execution instruction; quality scores are methodology assessments, not probabilities of profit. Numbers come from the listed data sources and deterministic calculations; narratives are interpretations and can be wrong.</p>;
}

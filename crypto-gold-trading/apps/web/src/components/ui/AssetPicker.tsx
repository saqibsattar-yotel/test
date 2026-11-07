import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui";
import { searchAssets, useAssets, type AssetInfo } from "@/lib/assets";
import { cls } from "@/lib/format";

/**
 * Searchable combobox over the live asset universe. Type a ticker or name (POL, ENA,
 * "ethena"…) and pick with the mouse or arrow keys + Enter.
 */
export function AssetPicker({ value, onSelect, placeholder = "Search any coin — e.g. POL, ENA, SUI…", exclude = [], cryptoOnly = false, className, size = "md", autoFocus }: { value?: string | null; onSelect: (id: string, info: AssetInfo) => void; placeholder?: string; exclude?: string[]; cryptoOnly?: boolean; className?: string; size?: "sm" | "md"; autoFocus?: boolean }) {
  const assets = useAssets();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const list = assets.data?.assets ?? [];
  const results = useMemo(() => searchAssets(list, q, { cryptoOnly, exclude, limit: 12 }), [list, q, cryptoOnly, exclude]);
  const selected = value ? list.find((a) => a.id === value) : undefined;
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const choose = (a: AssetInfo) => {
    onSelect(a.id, a);
    setQ("");
    setOpen(false);
  };
  return (
    <div ref={ref} className={cls("relative", className)}>
      <div className={cls("flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5", size === "sm" ? "h-8" : "h-9", open && "border-accent")}>
        <Search className="h-3.5 w-3.5 text-ink-3 shrink-0" />
        <input
          autoFocus={autoFocus}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(results.length - 1, i + 1));
              setOpen(true);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter" && results[idx]) {
              e.preventDefault();
              choose(results[idx]);
            } else if (e.key === "Escape") {
              setOpen(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder={selected && !q ? `${selected.symbol} — ${selected.name}` : placeholder}
          aria-label="Search assets"
          role="combobox"
          aria-expanded={open}
          className={cls("flex-1 min-w-0 bg-transparent outline-none text-ink-1 placeholder:text-ink-3", size === "sm" ? "text-xs" : "text-sm", selected && !q && "placeholder:text-ink-1")}
        />
        {assets.data && <span className="text-[10px] text-ink-3 tabular hidden sm:inline">{assets.data.total} assets</span>}
      </div>
      {open && (
        <div role="listbox" className="absolute z-50 mt-1 w-full min-w-[280px] max-h-80 overflow-y-auto card shadow-2xl fade-in">
          {assets.isLoading && <p className="px-3 py-3 text-xs text-ink-3">Loading universe…</p>}
          {assets.isError && <p className="px-3 py-3 text-xs text-bear">Could not load the asset list.</p>}
          {!assets.isLoading && results.length === 0 && <p className="px-3 py-3 text-xs text-ink-3">No match for “{q}”. The universe is Binance USDT spot pairs plus XAU/USD.</p>}
          {results.map((a, i) => (
            <button key={a.id} role="option" aria-selected={i === idx} onMouseEnter={() => setIdx(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(a)} className={cls("w-full flex items-center gap-2.5 px-3 h-10 text-left", i === idx ? "bg-surface-3" : "")}>
              <span className={cls("inline-flex h-7 w-7 items-center justify-center rounded-md text-[11px] font-bold shrink-0", a.assetClass === "gold" ? "bg-gold-soft text-gold" : "bg-accent-soft text-accent")}>{a.base.slice(0, 3)}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-ink-1 truncate">
                  {a.symbol} <span className="text-ink-3">· {a.name}</span>
                </span>
              </span>
              {a.rank && (
                <Badge tone="muted" size="sm">
                  #{a.rank}
                </Badge>
              )}
              {a.core && (
                <Badge tone="accent" size="sm">
                  core
                </Badge>
              )}
            </button>
          ))}
          {!q && results.length > 0 && <p className="px-3 py-2 text-[10.5px] text-ink-3 border-t border-line">Showing top assets by market cap — type to search all {assets.data?.total ?? ""}.</p>}
        </div>
      )}
    </div>
  );
}

/** Removable chip for a selected asset. */
export function AssetChip({ id, label, tone = "accent", onRemove, onClick, active = true }: { id: string; label: string; tone?: "accent" | "gold"; onRemove?: () => void; onClick?: () => void; active?: boolean }) {
  return (
    <span className={cls("inline-flex items-center gap-1 h-7 rounded-md border px-2 text-xs font-medium", active ? (tone === "gold" ? "border-gold/40 bg-gold-soft text-gold" : "border-accent/40 bg-accent-soft text-accent") : "border-line text-ink-3")} data-asset={id}>
      <button onClick={onClick} className="focus:outline-none">
        {label}
      </button>
      {onRemove && (
        <button aria-label={`Remove ${label}`} onClick={onRemove} className="text-current/70 hover:text-current">
          ×
        </button>
      )}
    </span>
  );
}

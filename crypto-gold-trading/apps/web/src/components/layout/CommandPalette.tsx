import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Search } from "lucide-react";
import { Kbd } from "@/components/ui";
import { searchAssets, useAssets } from "@/lib/assets";
import { useUi } from "@/lib/store";
import { cls } from "@/lib/format";
import { NAV } from "./nav";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

export function CommandPalette() {
  const open = useUi((s) => s.commandOpen);
  const setOpen = useUi((s) => s.setCommandOpen);
  const setCrypto = useUi((s) => s.setSelectedCrypto);
  const setSelected = useUi((s) => s.setSelectedAsset);
  const setTheme = useUi((s) => s.setTheme);
  const theme = useUi((s) => s.theme);
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const universe = useAssets();
  const cmds = useMemo<Cmd[]>(() => {
    const go = (to: string) => () => navigate(to);
    const pages: Cmd[] = NAV.map((n) => ({ id: `p:${n.to}`, label: n.label, hint: `g ${n.key}`, group: "Pages", run: go(n.to) }));
    const assets: Cmd[] = searchAssets(universe.data?.assets ?? [], q, { limit: q.trim() ? 12 : 8 }).map((a) => ({
      id: `a:${a.id}`,
      label: `${a.symbol} — ${a.name}${a.rank ? `  #${a.rank}` : ""}`,
      hint: a.assetClass === "gold" ? "Gold workspace" : "Crypto workspace",
      group: "Assets",
      run: () => {
        setSelected(a.id);
        if (a.assetClass === "gold") navigate("/gold");
        else {
          setCrypto(a.id);
          navigate("/crypto");
        }
      },
    }));
    const actions: Cmd[] = [
      { id: "x:theme", label: `Switch to ${theme === "dark" ? "light" : "dark"} theme`, hint: "t", group: "Actions", run: () => setTheme(theme === "dark" ? "light" : "dark") },
      { id: "x:new-trade", label: "Log a new trade", group: "Actions", run: () => navigate("/journal?new=1") },
      { id: "x:calc", label: "Open position-size calculator", group: "Actions", run: () => navigate("/risk") },
      { id: "x:calendar", label: "Economic calendar", group: "Actions", run: () => navigate("/intelligence?tab=calendar") },
    ];
    return [...pages, ...assets, ...actions];
  }, [navigate, setCrypto, setSelected, setTheme, theme, universe.data, q]);
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return cmds;
    // Asset commands are already search-filtered; pages/actions match on label.
    return cmds.filter((c) => c.group === "Assets" || c.label.toLowerCase().includes(t) || c.group.toLowerCase().includes(t));
  }, [cmds, q]);
  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);
  if (!open) return null;
  const run = (c: Cmd) => {
    c.run();
    setOpen(false);
  };
  const groups = [...new Set(filtered.map((c) => c.group))];
  return createPortal(
    <div className="fixed inset-0 z-[96] flex items-start justify-center pt-[12vh] px-4" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
      <div className="relative w-full max-w-lg card shadow-2xl overflow-hidden fade-in">
        <div className="flex items-center gap-2 px-3 border-b border-line">
          <Search className="h-4 w-4 text-ink-3" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIdx((i) => Math.min(filtered.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIdx((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter" && filtered[idx]) run(filtered[idx]);
              else if (e.key === "Escape") setOpen(false);
            }}
            placeholder={`Jump to a page, any of ${universe.data?.total ?? "500+"} assets, or an action…`}
            className="h-12 flex-1 bg-transparent text-sm text-ink-1 placeholder:text-ink-3 outline-none"
          />
          <Kbd>esc</Kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-2">
          {filtered.length === 0 && <p className="px-4 py-6 text-sm text-ink-3 text-center">No matches</p>}
          {groups.map((g) => (
            <div key={g}>
              <div className="px-4 pt-2 pb-1 text-[10.5px] uppercase tracking-wider text-ink-3">{g}</div>
              {filtered
                .filter((c) => c.group === g)
                .map((c) => {
                  const i = filtered.indexOf(c);
                  return (
                    <button key={c.id} onMouseEnter={() => setIdx(i)} onClick={() => run(c)} className={cls("w-full flex items-center justify-between px-4 h-9 text-sm", i === idx ? "bg-surface-3 text-ink-1" : "text-ink-2")}>
                      <span className="truncate">{c.label}</span>
                      <span className="flex items-center gap-2 text-xs text-ink-3">
                        {c.hint}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </span>
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

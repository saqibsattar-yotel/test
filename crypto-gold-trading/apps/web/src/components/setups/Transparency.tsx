import type { TradeSetup } from "@terminal/core";
import { Badge, Checkmark, Tooltip } from "@/components/ui";
import { cls, fmtDateTime, fmtPrice } from "@/lib/format";
import { useUi } from "@/lib/store";

/** Calculated facts behind a setup: indicator contributions, MTF agreement, evidence sufficiency, data freshness. */
export function SetupTransparency({ setup, compact = false }: { setup: TradeSetup; compact?: boolean }) {
  const tz = useUi((s) => s.timezone);
  const c = setup.contributions ?? [];
  const m = setup.mtfConfirmation ?? [];
  const suf = setup.sufficiency;
  const ds = setup.dataStatus ?? [];
  const kl = setup.keyLevels;
  return (
    <div className={cls("space-y-4", compact && "space-y-3")}>
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <Badge tone="accent" size="sm">
          Calculated facts
        </Badge>
        <span className="text-ink-3">Everything in this panel is computed from verified candles; nothing here comes from a language model.</span>
      </div>

      {ds.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wider text-ink-3 mb-1">Data status</p>
          <div className="flex flex-wrap gap-1.5">
            {ds.map((d) => (
              <Tooltip key={d.timeframe} content={d.issues.length ? d.issues.join("; ") : "No issues"}>
                <span className={cls("inline-flex items-center gap-1.5 rounded-md border px-2 h-6 text-[11px] cursor-help", d.stale ? "border-warn/50 text-warn" : d.ok ? "border-line text-ink-2" : "border-bear/50 text-bear")}>
                  <span className="font-semibold">{d.timeframe}</span>
                  <span className="tabular">{fmtDateTime(d.asOf, tz)}</span>
                  <span className="text-ink-3">· {d.bars} bars</span>
                  {d.stale && <span>· STALE</span>}
                  {!d.ok && <span>· issues</span>}
                </span>
              </Tooltip>
            ))}
          </div>
        </div>
      )}

      {m.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wider text-ink-3 mb-1">
            Multi-timeframe confirmation{" "}
            <Badge tone={setup.mtfConfirmed ? "bull" : "warning"} size="sm" className="ml-1">
              {setup.mtfConfirmed ? "confirmed" : "not confirmed"}
            </Badge>
          </p>
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${m.length}, minmax(0, 1fr))` }}>
            {m.map((x) => (
              <Tooltip key={x.timeframe} content={x.note || "—"}>
                <div className={cls("rounded-md border px-2 py-1.5 text-center cursor-help", x.agrees === true ? "border-bull/40 bg-bull-soft" : x.agrees === false ? "border-bear/40 bg-bear-soft" : "border-line bg-surface-2")}>
                  <div className="text-[11px] font-semibold text-ink-1">
                    {x.timeframe}
                    {x.timeframe === setup.timeframe ? " · trade" : x.timeframe === setup.contextTimeframe ? " · ctx" : ""}
                  </div>
                  <div className={cls("text-xs capitalize", x.agrees === true ? "text-bull" : x.agrees === false ? "text-bear" : "text-ink-3")}>
                    {x.bias} {x.agrees === true ? "✓" : x.agrees === false ? "✗" : "–"}
                  </div>
                </div>
              </Tooltip>
            ))}
          </div>
        </div>
      )}

      {suf && (
        <div>
          <p className="text-[11px] uppercase tracking-wider text-ink-3 mb-1">
            Evidence sufficiency{" "}
            <Badge tone={suf.sufficient ? "bull" : "warning"} size="sm" className="ml-1">
              {suf.sufficient ? "sufficient" : "insufficient"}
            </Badge>
          </p>
          <div className="flex items-center gap-3 text-xs text-ink-2">
            <span>
              Supporting <span className="text-bull font-semibold tabular">{suf.supportingWeight}</span> ({suf.supportingCount} items)
            </span>
            <span>
              Opposing <span className="text-bear font-semibold tabular">{suf.opposingWeight}</span>
            </span>
            <span className="text-ink-3">categories: {suf.categoriesCovered.join(", ") || "—"}</span>
          </div>
          <div className="mt-1.5 h-1.5 rounded-full bg-surface-3 overflow-hidden flex">
            <div className="h-full bg-bull" style={{ width: `${(suf.supportingWeight / Math.max(1, suf.supportingWeight + suf.opposingWeight)) * 100}%` }} />
            <div className="h-full bg-bear" style={{ width: `${(suf.opposingWeight / Math.max(1, suf.supportingWeight + suf.opposingWeight)) * 100}%` }} />
          </div>
          {suf.reasons.length > 0 && (
            <ul className="mt-1.5 text-[11px] text-warn space-y-0.5">
              {suf.reasons.map((r, i) => (
                <li key={i}>• {r}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {c.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wider text-ink-3 mb-1">Indicator contributions</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-ink-3 text-left">
                <th className="py-1 font-medium">Indicator</th>
                <th className="py-1 font-medium">TF</th>
                <th className="py-1 font-medium text-right">Value</th>
                <th className="py-1 font-medium">Read</th>
                <th className="py-1 font-medium text-right">Weight</th>
              </tr>
            </thead>
            <tbody>
              {c.map((x, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="py-1 text-ink-1">
                    {x.indicator}
                    {x.note && <span className="text-ink-3"> · {x.note}</span>}
                  </td>
                  <td className="py-1 text-ink-2">{x.timeframe}</td>
                  <td className="py-1 tabular text-right text-ink-1">{x.value}</td>
                  <td className={cls("py-1 capitalize", x.read === "bullish" ? "text-bull" : x.read === "bearish" ? "text-bear" : "text-ink-3")}>{x.read}</td>
                  <td className={cls("py-1 tabular text-right font-semibold", x.weight > 0 ? "text-bull" : x.weight < 0 ? "text-bear" : "text-ink-3")}>
                    {x.weight > 0 ? "+" : ""}
                    {x.weight}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {kl && (
        <div className="grid sm:grid-cols-2 gap-3 text-xs">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-ink-3 mb-1">Key levels</p>
            <ul className="space-y-0.5">
              {kl.resistance
                .slice()
                .reverse()
                .map((l, i) => (
                  <li key={`r${i}`} className="flex justify-between gap-2">
                    <span className="text-ink-2 truncate">{l.label}</span>
                    <span className="tabular text-bear">{fmtPrice(l.price, setup.assetId)}</span>
                  </li>
                ))}
              <li className="flex justify-between gap-2 border-y border-line py-0.5">
                <span className="text-ink-3">price</span>
                <span className="tabular text-ink-1">{fmtPrice(setup.currentPrice, setup.assetId)}</span>
              </li>
              {kl.support.map((l, i) => (
                <li key={`s${i}`} className="flex justify-between gap-2">
                  <span className="text-ink-2 truncate">{l.label}</span>
                  <span className="tabular text-bull">{fmtPrice(l.price, setup.assetId)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-ink-3 mb-1">Liquidity & structure</p>
            <ul className="space-y-0.5">
              {kl.liquidityAbove.map((l, i) => (
                <li key={`la${i}`} className="flex justify-between gap-2">
                  <span className="text-ink-2 truncate">{l.label}</span>
                  <span className="tabular text-bear">{fmtPrice(l.price, setup.assetId)}</span>
                </li>
              ))}
              {kl.liquidityBelow.map((l, i) => (
                <li key={`lb${i}`} className="flex justify-between gap-2">
                  <span className="text-ink-2 truncate">{l.label}</span>
                  <span className="tabular text-bull">{fmtPrice(l.price, setup.assetId)}</span>
                </li>
              ))}
              {kl.liquidityAbove.length + kl.liquidityBelow.length === 0 && <li className="text-ink-3">No equal-high/low clusters nearby</li>}
            </ul>
            <p className="mt-2 text-ink-2">
              <span className="text-ink-3">Structure: </span>
              <span className="capitalize">{kl.structure.trend}</span> — {kl.structure.description}
              {kl.structure.breakout ? ` · ${kl.structure.breakout}` : ""}
            </p>
            <p className="text-ink-3 tabular">
              swing high {kl.structure.lastSwingHigh !== null ? fmtPrice(kl.structure.lastSwingHigh, setup.assetId) : "—"} · swing low {kl.structure.lastSwingLow !== null ? fmtPrice(kl.structure.lastSwingLow, setup.assetId) : "—"}
            </p>
          </div>
        </div>
      )}

      {(setup.entryBasis || setup.stopBasis) && (
        <div className="text-xs text-ink-2 space-y-1">
          {setup.entryBasis && (
            <p>
              <span className="text-ink-3">Entry basis: </span>
              {setup.entryBasis}
            </p>
          )}
          {setup.stopBasis && (
            <p>
              <span className="text-ink-3">Stop basis: </span>
              {setup.stopBasis}
            </p>
          )}
          {setup.targets.map((t) => (
            <p key={t.label}>
              <span className="text-ink-3">{t.label} basis: </span>
              {t.basis}
            </p>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 text-[11px] text-ink-3">
        <Checkmark ok={!!setup.mtfConfirmed} /> MTF confirmed
        <Checkmark ok={!!setup.sufficiency?.sufficient} /> Evidence sufficient
        <Checkmark ok={!ds.some((d) => d.stale)} /> Data fresh
      </div>
    </div>
  );
}

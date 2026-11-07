import type { AssetId, IndicatorSnapshot, Level, SRLevel, StructureSummary } from "@terminal/core";
import { Badge, Tooltip } from "@/components/ui";
import { cls, fmtCompact, fmtNum, fmtPct, fmtPrice } from "@/lib/format";
import { useUi } from "@/lib/store";
import { fmtDateTime } from "@/lib/format";

function Row({ label, value, tone, hint }: { label: string; value: string; tone?: "bull" | "bear" | "neutral" | "gold"; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-line last:border-0 text-xs">
      <span className="text-ink-3 flex items-center gap-1.5">
        {label}
        {hint && (
          <Tooltip content={hint}>
            <span className="text-ink-3/70 cursor-help">ⓘ</span>
          </Tooltip>
        )}
      </span>
      <span className={cls("tabular font-medium", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : tone === "gold" ? "text-gold" : "text-ink-1")}>{value}</span>
    </div>
  );
}

export function IndicatorPanel({ ind, assetId }: { ind: IndicatorSnapshot; assetId: AssetId }) {
  const pos = (v: number) => (Number.isFinite(v) ? (ind.close > v ? "bull" : "bear") : "neutral");
  const rsiTone = ind.rsi14 >= 70 ? "bear" : ind.rsi14 <= 30 ? "bull" : ind.rsi14 > 55 ? "bull" : ind.rsi14 < 45 ? "bear" : "neutral";
  return (
    <div>
      <Row label="RSI (14)" value={`${fmtNum(ind.rsi14, 1)} ${ind.rsi14 >= 70 ? "overbought" : ind.rsi14 <= 30 ? "oversold" : ""}`} tone={rsiTone} hint="Wilder RSI. >70 overbought, <30 oversold, 45–55 neutral." />
      <Row label="MACD (12,26,9)" value={`${fmtNum(ind.macd.line, 2)} / sig ${fmtNum(ind.macd.signal, 2)}`} tone={ind.macd.line > ind.macd.signal ? "bull" : "bear"} />
      <Row label="MACD histogram" value={`${ind.macd.histogram >= 0 ? "+" : ""}${fmtNum(ind.macd.histogram, 2)} (${Math.abs(ind.macd.histogram) > Math.abs(ind.macd.histogramPrev) ? "expanding" : "contracting"})`} tone={ind.macd.histogram >= 0 ? "bull" : "bear"} />
      <Row label="EMA 20" value={`${fmtPrice(ind.ema20, assetId)} · price ${ind.close > ind.ema20 ? "above" : "below"}`} tone={pos(ind.ema20)} />
      <Row label="EMA 50" value={`${fmtPrice(ind.ema50, assetId)} · price ${ind.close > ind.ema50 ? "above" : "below"}`} tone={pos(ind.ema50)} />
      <Row label="EMA 100" value={Number.isFinite(ind.ema100) ? `${fmtPrice(ind.ema100, assetId)} · price ${ind.close > ind.ema100 ? "above" : "below"}` : "insufficient bars"} tone={pos(ind.ema100)} />
      <Row label="EMA 200" value={Number.isFinite(ind.ema200) ? `${fmtPrice(ind.ema200, assetId)} · price ${ind.close > ind.ema200 ? "above" : "below"}` : "insufficient bars"} tone={pos(ind.ema200)} />
      <Row label="EMA stack" value={ind.emaStack} tone={ind.emaStack === "bullish" ? "bull" : ind.emaStack === "bearish" ? "bear" : "neutral"} hint="20 > 50 > 200 is bullish; 20 < 50 < 200 bearish; otherwise mixed." />
      <Row label="VWAP (UTC day)" value={`${fmtPrice(ind.vwap, assetId)} · price ${ind.close > ind.vwap ? "above" : "below"}`} tone={pos(ind.vwap)} />
      <Row label="Bollinger (20,2)" value={`${fmtPrice(ind.bollinger.lower, assetId)} – ${fmtPrice(ind.bollinger.upper, assetId)}`} hint={`Middle ${fmtPrice(ind.bollinger.middle, assetId)} · %B ${fmtNum(ind.bollinger.percentB, 2)} · bandwidth ${fmtPct(ind.bollinger.bandwidth * 100, 2, false)}`} />
      <Row label="%B / squeeze" value={`${fmtNum(ind.bollinger.percentB, 2)}${ind.bollinger.squeeze ? " · SQUEEZE" : ""}`} tone={ind.bollinger.squeeze ? "gold" : ind.bollinger.percentB > 1 ? "bear" : ind.bollinger.percentB < 0 ? "bull" : "neutral"} />
      <Row label="ATR (14)" value={`${fmtPrice(ind.atr14, assetId)} · ${fmtNum(ind.atrPct, 2)}%`} hint="Average true range; the setup engine uses it for stop buffers and noise checks." />
      <Row label="ADX (14)" value={`${fmtNum(ind.adx14, 0)} · +DI ${fmtNum(ind.plusDI, 0)} / −DI ${fmtNum(ind.minusDI, 0)}`} tone={ind.adx14 >= 25 ? (ind.plusDI > ind.minusDI ? "bull" : "bear") : "neutral"} hint=">25 trending, <18 ranging." />
      {ind.volume && (
        <>
          <Row label="Relative volume" value={`${fmtNum(ind.volume.relativeVolume, 2)}x avg${ind.volume.spike ? " · SPIKE" : ""}`} tone={ind.volume.spike ? "gold" : "neutral"} />
          <Row label="Volume trend / OBV" value={`${ind.volume.trend} / OBV ${ind.volume.obvDirection}`} tone={ind.volume.obvDirection === "rising" ? "bull" : ind.volume.obvDirection === "falling" ? "bear" : "neutral"} />
          <Row label="Up/down volume" value={Number.isFinite(ind.volume.upDownRatio) ? `${fmtNum(ind.volume.upDownRatio, 2)} (20 bars)` : "all up"} tone={ind.volume.upDownRatio > 1.2 ? "bull" : ind.volume.upDownRatio < 0.8 ? "bear" : "neutral"} />
          <Row label="Avg volume (20)" value={fmtCompact(ind.volume.avgVolume, 2)} />
        </>
      )}
    </div>
  );
}

export function StructurePanel({ structure, assetId, price }: { structure: StructureSummary; assetId: AssetId; price: number }) {
  const tz = useUi((s) => s.timezone);
  const tone = structure.trend === "uptrend" ? "bull" : structure.trend === "downtrend" ? "bear" : "neutral";
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge tone={tone} className="capitalize">
          {structure.trend}
        </Badge>
        {structure.breakout && (
          <Badge tone={structure.breakout.type === "bullish" ? "bull" : "bear"}>
            {structure.breakout.type === "bullish" ? "Breakout" : "Breakdown"} {fmtPrice(structure.breakout.level, assetId)} · {structure.breakout.barsAgo === 0 ? "latest bar" : `${structure.breakout.barsAgo} bars ago`}
          </Badge>
        )}
      </div>
      <p className="text-sm text-ink-2">{structure.description}</p>
      <div className="flex gap-1 flex-wrap">
        {structure.sequence.map((s, i) => (
          <span key={i} className={cls("px-1.5 h-6 inline-flex items-center rounded text-[11px] font-semibold", s === "HH" || s === "HL" ? "bg-bull-soft text-bull" : "bg-bear-soft text-bear")}>
            {s}
          </span>
        ))}
        {structure.sequence.length === 0 && <span className="text-xs text-ink-3">Not enough swings yet</span>}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="card p-2.5">
          <div className="text-ink-3">Last swing high</div>
          <div className="tabular text-ink-1 font-medium">{structure.lastSwingHigh ? fmtPrice(structure.lastSwingHigh.price, assetId) : "—"}</div>
          <div className="text-[10.5px] text-ink-3">{structure.lastSwingHigh ? `${fmtDateTime(structure.lastSwingHigh.time, tz)} · ${fmtPct(((structure.lastSwingHigh.price - price) / price) * 100)}` : ""}</div>
        </div>
        <div className="card p-2.5">
          <div className="text-ink-3">Last swing low</div>
          <div className="tabular text-ink-1 font-medium">{structure.lastSwingLow ? fmtPrice(structure.lastSwingLow.price, assetId) : "—"}</div>
          <div className="text-[10.5px] text-ink-3">{structure.lastSwingLow ? `${fmtDateTime(structure.lastSwingLow.time, tz)} · ${fmtPct(((structure.lastSwingLow.price - price) / price) * 100)}` : ""}</div>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-1 text-center text-xs">
        {[
          ["HH", structure.higherHighs, "bull"],
          ["HL", structure.higherLows, "bull"],
          ["LH", structure.lowerHighs, "bear"],
          ["LL", structure.lowerLows, "bear"],
        ].map(([k, v, t]) => (
          <div key={String(k)} className="card py-1.5">
            <div className={cls("font-semibold", t === "bull" ? "text-bull" : "text-bear")}>{String(v)}</div>
            <div className="text-[10.5px] text-ink-3">{String(k)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LevelsTable({ support, resistance, liquidity, assetId, price }: { support: SRLevel[]; resistance: SRLevel[]; liquidity: Level[]; assetId: AssetId; price: number }) {
  const rows = [...resistance.slice(0, 5).reverse().map((l) => ({ ...l, type: "resistance" as const })), ...support.slice(0, 5).map((l) => ({ ...l, type: "support" as const }))];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-ink-3 text-left">
            <th className="px-4 py-2 font-medium">Level</th>
            <th className="px-2 py-2 font-medium">Zone</th>
            <th className="px-2 py-2 font-medium text-right">Dist.</th>
            <th className="px-2 py-2 font-medium text-right">Touches</th>
            <th className="px-4 py-2 font-medium text-right">Strength</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l, i) => (
            <tr key={i} className={cls("border-t border-line", l.type === "support" && i === resistance.slice(0, 5).length && "border-t-2 border-t-accent/40")}>
              <td className={cls("px-4 py-1.5 tabular font-medium", l.type === "resistance" ? "text-bear" : "text-bull")}>{fmtPrice(l.price, assetId)}</td>
              <td className="px-2 py-1.5 tabular text-ink-3">
                {fmtPrice(l.zoneLow, assetId)}–{fmtPrice(l.zoneHigh, assetId)}
              </td>
              <td className="px-2 py-1.5 tabular text-right text-ink-2">{fmtPct(((l.price - price) / price) * 100)}</td>
              <td className="px-2 py-1.5 tabular text-right text-ink-2">{l.touches}</td>
              <td className="px-4 py-1.5 text-right">
                <div className="inline-flex items-center gap-1.5">
                  <div className="h-1.5 w-14 rounded-full bg-surface-3 overflow-hidden">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${l.strength * 100}%` }} />
                  </div>
                  <span className="tabular text-ink-3 w-7">{Math.round(l.strength * 100)}</span>
                </div>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-4 text-ink-3 text-center">
                No clustered levels on this timeframe yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {liquidity.length > 0 && (
        <div className="px-4 py-2.5 border-t border-line">
          <p className="text-[11px] uppercase tracking-wider text-ink-3 mb-1">Liquidity zones (equal highs / lows)</p>
          <div className="flex flex-wrap gap-1.5">
            {liquidity.map((l, i) => (
              <Tooltip key={i} content={l.label}>
                <span className={cls("px-2 h-6 inline-flex items-center rounded text-[11px] tabular cursor-help", l.price > price ? "bg-bear-soft text-bear" : "bg-bull-soft text-bull")}>
                  {fmtPrice(l.price, assetId)} · {l.touches}×
                </span>
              </Tooltip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

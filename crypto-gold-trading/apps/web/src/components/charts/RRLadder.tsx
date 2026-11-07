import type { TradeSetup } from "@terminal/core";
import { fmtPrice } from "@/lib/format";

/**
 * Horizontal price-level visualisation: stop → entry zone → TP1/2/3 with risk and
 * reward zones shaded. Pure SVG, responsive via viewBox.
 */
export function RRLadder({ setup, currentPrice, compact = false }: { setup: TradeSetup; currentPrice?: number; compact?: boolean }) {
  if (setup.status === "NO TRADE" || setup.stopLoss === null || !setup.direction) return null;
  const W = 600;
  const H = compact ? 78 : 104;
  const padL = 14;
  const padR = 14;
  const prices = [setup.stopLoss, setup.entry.low, setup.entry.high, ...setup.targets.map((t) => t.price), currentPrice ?? setup.currentPrice].filter((p): p is number => Number.isFinite(p));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const x = (p: number) => padL + ((p - min) / span) * (W - padL - padR);
  const long = setup.direction === "LONG";
  const yBar = compact ? 30 : 40;
  const barH = 10;
  const entryMid = x(setup.entry.mid);
  const stopX = x(setup.stopLoss);
  const tp3X = x(setup.targets[setup.targets.length - 1].price);
  const riskX1 = Math.min(stopX, entryMid);
  const riskX2 = Math.max(stopX, entryMid);
  const rewX1 = Math.min(entryMid, tp3X);
  const rewX2 = Math.max(entryMid, tp3X);
  const cur = currentPrice ?? setup.currentPrice;
  const labelY = yBar + barH + 16;
  const topLabelY = yBar - 10;
  const ta = (px: number): "start" | "middle" | "end" => (px < 70 ? "start" : px > W - 70 ? "end" : "middle");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`${setup.direction} plan: stop ${setup.stopLoss}, entry ${setup.entry.mid}, targets ${setup.targets.map((t) => t.price).join(", ")}`}>
      <rect x={padL} y={yBar} width={W - padL - padR} height={barH} rx={5} fill="var(--surface-3)" />
      <rect x={riskX1} y={yBar} width={Math.max(2, riskX2 - riskX1)} height={barH} rx={5} fill="var(--bear)" opacity={0.55} />
      <rect x={rewX1} y={yBar} width={Math.max(2, rewX2 - rewX1)} height={barH} rx={5} fill="var(--bull)" opacity={0.5} />
      {/* entry zone */}
      <rect x={Math.min(x(setup.entry.low), x(setup.entry.high)) - 1} y={yBar - 4} width={Math.max(3, Math.abs(x(setup.entry.high) - x(setup.entry.low)) + 2)} height={barH + 8} rx={3} fill="var(--accent)" opacity={0.9} />
      {/* stop */}
      <line x1={stopX} x2={stopX} y1={yBar - 8} y2={yBar + barH + 8} stroke="var(--bear)" strokeWidth={2} strokeLinecap="round" />
      <text x={stopX} y={long ? labelY : topLabelY} textAnchor={ta(stopX)} fontSize={11} fill="var(--ink-2)" className="tabular">
        SL {fmtPrice(setup.stopLoss, setup.assetId)}
      </text>
      <text x={stopX} y={(long ? labelY : topLabelY) + (long ? 13 : -13)} textAnchor={ta(stopX)} fontSize={10} fill="var(--ink-3)">
        −1.0R
      </text>
      {/* entry */}
      <text x={entryMid} y={topLabelY} textAnchor={ta(entryMid)} fontSize={11} fill="var(--ink-1)" fontWeight={600} className="tabular">
        Entry {fmtPrice(setup.entry.mid, setup.assetId)}
      </text>
      {/* targets */}
      {setup.targets.map((t, i) => {
        const tx = x(t.price);
        const up = i % 2 === 0;
        return (
          <g key={t.label}>
            <line x1={tx} x2={tx} y1={yBar - 6} y2={yBar + barH + 6} stroke="var(--bull)" strokeWidth={2} strokeLinecap="round" />
            <text x={tx} y={up ? labelY : topLabelY} textAnchor={ta(tx)} fontSize={11} fill="var(--ink-2)" className="tabular">
              {t.label} {fmtPrice(t.price, setup.assetId)}
            </text>
            <text x={tx} y={up ? labelY + 13 : topLabelY - 13} textAnchor={ta(tx)} fontSize={10} fill="var(--ink-3)">
              +{t.rMultiple.toFixed(1)}R
            </text>
          </g>
        );
      })}
      {/* current price marker */}
      {Number.isFinite(cur) && (
        <g>
          <polygon points={`${x(cur) - 5},${yBar + barH + 4} ${x(cur) + 5},${yBar + barH + 4} ${x(cur)},${yBar + barH - 2}`} fill="var(--ink-1)" />
          {!compact && (
            <text x={x(cur)} y={H - 4} textAnchor="middle" fontSize={10} fill="var(--ink-3)" className="tabular">
              now {fmtPrice(cur, setup.assetId)}
            </text>
          )}
        </g>
      )}
    </svg>
  );
}

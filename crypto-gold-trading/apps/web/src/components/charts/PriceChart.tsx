import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, ColorType, CrosshairMode, LineStyle, type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp, type LogicalRange } from "lightweight-charts";
import type { AssetId, Candle, Level, Timeframe, TradeSetup } from "@terminal/core";
import { ema, bollinger, vwap, rsi, macd } from "@terminal/core";
import { cls, fmtPrice, precisionFor } from "@/lib/format";
import { useUi } from "@/lib/store";

export interface OverlayToggles {
  ema20: boolean;
  ema50: boolean;
  ema100: boolean;
  ema200: boolean;
  bb: boolean;
  vwap: boolean;
  volume: boolean;
  levels: boolean;
}

export const DEFAULT_OVERLAYS: OverlayToggles = { ema20: true, ema50: true, ema100: false, ema200: true, bb: false, vwap: false, volume: true, levels: true };

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function themeColors() {
  return {
    bg: cssVar("--surface-1"),
    text: cssVar("--ink-3"),
    grid: cssVar("--grid"),
    axis: cssVar("--axis"),
    bull: cssVar("--bull"),
    bear: cssVar("--bear"),
    gold: cssVar("--gold"),
    accent: cssVar("--accent"),
    s1: cssVar("--series-1"),
    s2: cssVar("--series-2"),
    s3: cssVar("--series-3"),
    s4: cssVar("--series-4"),
    s7: cssVar("--series-7"),
    ink1: cssVar("--ink-1"),
  };
}

const toTs = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

export function PriceChart({ assetId, timeframe, candles, overlays = DEFAULT_OVERLAYS, levels = [], setup, height = 420, className, showIndicators = true, maxLevels = 6 }: { assetId: AssetId; timeframe: Timeframe; candles: Candle[]; overlays?: OverlayToggles; levels?: Level[]; setup?: TradeSetup | null; height?: number; className?: string; showIndicators?: boolean; maxLevels?: number }) {
  const mainRef = useRef<HTMLDivElement>(null);
  const rsiRef = useRef<HTMLDivElement>(null);
  const macdRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const rsiChartRef = useRef<IChartApi | null>(null);
  const macdChartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{ candle: ISeriesApi<"Candlestick">; volume: ISeriesApi<"Histogram">; lines: Record<string, ISeriesApi<"Line">>; rsi?: ISeriesApi<"Line">; macdHist?: ISeriesApi<"Histogram">; macdLine?: ISeriesApi<"Line">; macdSig?: ISeriesApi<"Line"> } | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const theme = useUi((s) => s.theme);
  const [hover, setHover] = useState<Candle | null>(null);
  const prec = precisionFor(assetId, candles[candles.length - 1]?.close);

  const computed = useMemo(() => {
    const closes = candles.map((c) => c.close);
    return { e20: ema(closes, 20), e50: ema(closes, 50), e100: ema(closes, 100), e200: ema(closes, 200), bb: bollinger(closes, 20, 2), vw: vwap(candles), rsi: rsi(closes, 14), macd: macd(closes) };
  }, [candles]);

  // Create charts once
  useEffect(() => {
    if (!mainRef.current) return;
    const c = themeColors();
    const common = {
      layout: { background: { type: ColorType.Solid, color: c.bg }, textColor: c.text, fontFamily: "Inter, system-ui, sans-serif", fontSize: 11 },
      grid: { vertLines: { color: c.grid, style: LineStyle.Solid }, horzLines: { color: c.grid, style: LineStyle.Solid } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: c.axis, labelBackgroundColor: c.axis }, horzLine: { color: c.axis, labelBackgroundColor: c.axis } },
      rightPriceScale: { borderColor: c.axis, scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderColor: c.axis, timeVisible: true, secondsVisible: false, rightOffset: 6 },
      handleScroll: true,
      handleScale: true,
    };
    const chart = createChart(mainRef.current, { ...common, width: mainRef.current.clientWidth, height });
    const candle = chart.addCandlestickSeries({ upColor: c.bull, downColor: c.bear, borderUpColor: c.bull, borderDownColor: c.bear, wickUpColor: c.bull, wickDownColor: c.bear, priceFormat: { type: "price", precision: prec, minMove: Math.pow(10, -prec) } });
    const volume = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
    const mk = (color: string, width: 1 | 2 = 1, style = LineStyle.Solid) => chart.addLineSeries({ color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, lineStyle: style });
    const lines: Record<string, ISeriesApi<"Line">> = { ema20: mk(c.s1), ema50: mk(c.s2), ema100: mk(c.s7), ema200: mk(c.s4, 2), bbU: mk(c.s3, 1, LineStyle.Dotted), bbM: mk(c.s3, 1, LineStyle.Dotted), bbL: mk(c.s3, 1, LineStyle.Dotted), vwap: mk(c.accent, 1, LineStyle.Dashed) };
    seriesRef.current = { candle, volume, lines };
    chartRef.current = chart;

    let rsiChart: IChartApi | null = null;
    let macdChart: IChartApi | null = null;
    if (showIndicators && rsiRef.current && macdRef.current) {
      rsiChart = createChart(rsiRef.current, { ...common, width: rsiRef.current.clientWidth, height: 110, rightPriceScale: { borderColor: c.axis, scaleMargins: { top: 0.1, bottom: 0.1 } }, timeScale: { ...common.timeScale, visible: false } });
      const rsiS = rsiChart.addLineSeries({ color: c.s7, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
      rsiS.createPriceLine({ price: 70, color: c.axis, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false, title: "" });
      rsiS.createPriceLine({ price: 30, color: c.axis, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false, title: "" });
      macdChart = createChart(macdRef.current, { ...common, width: macdRef.current.clientWidth, height: 110, rightPriceScale: { borderColor: c.axis, scaleMargins: { top: 0.1, bottom: 0.1 } } });
      const hist = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
      const ml = macdChart.addLineSeries({ color: c.s1, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const sg = macdChart.addLineSeries({ color: c.s2, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      seriesRef.current = { ...seriesRef.current, rsi: rsiS, macdHist: hist, macdLine: ml, macdSig: sg };
      rsiChartRef.current = rsiChart;
      macdChartRef.current = macdChart;
      // Sync time scales
      const sync = (src: IChartApi, targets: IChartApi[]) => src.timeScale().subscribeVisibleLogicalRangeChange((r: LogicalRange | null) => r && targets.forEach((t) => t.timeScale().setVisibleLogicalRange(r)));
      sync(chart, [rsiChart, macdChart]);
      sync(rsiChart, [chart, macdChart]);
      sync(macdChart, [chart, rsiChart]);
    }
    chart.subscribeCrosshairMove((p) => {
      if (!p.time || !p.seriesData.size) return setHover(null);
      const d = p.seriesData.get(candle) as { open: number; high: number; low: number; close: number } | undefined;
      const v = p.seriesData.get(volume) as { value: number } | undefined;
      if (d) setHover({ time: (p.time as number) * 1000, open: d.open, high: d.high, low: d.low, close: d.close, volume: v?.value ?? 0 });
    });
    const ro = new ResizeObserver(() => {
      if (mainRef.current) chart.applyOptions({ width: mainRef.current.clientWidth });
      if (rsiRef.current && rsiChart) rsiChart.applyOptions({ width: rsiRef.current.clientWidth });
      if (macdRef.current && macdChart) macdChart.applyOptions({ width: macdRef.current.clientWidth });
    });
    ro.observe(mainRef.current);
    return () => {
      ro.disconnect();
      chart.remove();
      rsiChart?.remove();
      macdChart?.remove();
      chartRef.current = null;
      seriesRef.current = null;
      priceLinesRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, height, showIndicators, assetId, prec]);

  // Data & overlays
  useEffect(() => {
    const s = seriesRef.current;
    if (!s || !candles.length) return;
    const c = themeColors();
    s.candle.setData(candles.map((k) => ({ time: toTs(k.time), open: k.open, high: k.high, low: k.low, close: k.close })));
    s.volume.setData(overlays.volume ? candles.map((k) => ({ time: toTs(k.time), value: k.volume, color: k.close >= k.open ? `${c.bull}55` : `${c.bear}55` })) : []);
    const lineData = (vals: number[]) => candles.map((k, i) => ({ time: toTs(k.time), value: vals[i] })).filter((p) => Number.isFinite(p.value));
    s.lines.ema20.setData(overlays.ema20 ? lineData(computed.e20) : []);
    s.lines.ema50.setData(overlays.ema50 ? lineData(computed.e50) : []);
    s.lines.ema100.setData(overlays.ema100 ? lineData(computed.e100) : []);
    s.lines.ema200.setData(overlays.ema200 ? lineData(computed.e200) : []);
    s.lines.bbU.setData(overlays.bb ? lineData(computed.bb.upper) : []);
    s.lines.bbM.setData(overlays.bb ? lineData(computed.bb.middle) : []);
    s.lines.bbL.setData(overlays.bb ? lineData(computed.bb.lower) : []);
    s.lines.vwap.setData(overlays.vwap ? lineData(computed.vw) : []);
    if (s.rsi) s.rsi.setData(lineData(computed.rsi));
    if (s.macdHist) s.macdHist.setData(candles.map((k, i) => ({ time: toTs(k.time), value: computed.macd.histogram[i], color: computed.macd.histogram[i] >= 0 ? `${c.bull}99` : `${c.bear}99` })).filter((p) => Number.isFinite(p.value)));
    if (s.macdLine) s.macdLine.setData(lineData(computed.macd.macd));
    if (s.macdSig) s.macdSig.setData(lineData(computed.macd.signal));
    // Price lines: levels + setup
    for (const pl of priceLinesRef.current) s.candle.removePriceLine(pl);
    priceLinesRef.current = [];
    const add = (price: number, color: string, title: string, style = LineStyle.Dashed, width: 1 | 2 = 1) => priceLinesRef.current.push(s.candle.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title }));
    if (overlays.levels) {
      const last = candles[candles.length - 1].close;
      const planPrices = setup && setup.stopLoss !== null ? [setup.entry.mid, setup.stopLoss, ...setup.targets.map((t) => t.price)] : [];
      const picks = levels
        .filter((l) => ["support", "resistance", "prev_day_high", "prev_day_low", "prev_week_high", "prev_week_low", "liquidity"].includes(l.kind) && Math.abs(l.price - last) / last < 0.08)
        .filter((l) => !planPrices.some((p) => Math.abs(p - l.price) / l.price < 0.004))
        .sort((a, b) => b.strength - a.strength)
        .slice(0, maxLevels);
      for (const l of picks) add(l.price, l.kind.includes("day") || l.kind.includes("week") ? c.gold : l.kind === "liquidity" ? c.s7 : l.price < last ? `${c.bull}` : `${c.bear}`, l.label.replace(/\(.*\)/, "").trim(), LineStyle.Dotted);
    }
    if (setup && setup.status !== "NO TRADE" && setup.stopLoss !== null) {
      add(setup.entry.mid, c.accent, `Entry ${setup.entry.low === setup.entry.high ? "" : `${fmtPrice(setup.entry.low, assetId)}–${fmtPrice(setup.entry.high, assetId)}`}`, LineStyle.Solid, 2);
      add(setup.stopLoss, c.bear, "Stop", LineStyle.Solid, 2);
      setup.targets.forEach((t) => add(t.price, c.bull, `${t.label} ${t.rMultiple.toFixed(1)}R`, LineStyle.Dashed, 1));
    }
    chartRef.current?.timeScale().fitContent();
    chartRef.current?.timeScale().scrollToRealTime();
  }, [candles, computed, overlays, levels, setup, assetId, theme, maxLevels]);

  const last = candles[candles.length - 1];
  const shown = hover ?? last;
  const prev = hover ? candles[Math.max(0, candles.findIndex((k) => k.time === hover.time) - 1)] : candles[candles.length - 2];
  const chg = shown && prev ? ((shown.close - prev.close) / prev.close) * 100 : 0;
  const idx = shown ? candles.findIndex((k) => k.time === shown.time) : -1;
  return (
    <div className={cls("relative", className)}>
      {shown && (
        <div className="absolute left-2 top-2 z-10 flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md bg-surface-1/85 backdrop-blur px-2 py-1 text-[11px] text-ink-2 tabular pointer-events-none">
          <span className="font-medium text-ink-1">{timeframe}</span>
          <span>O {fmtPrice(shown.open, assetId)}</span>
          <span>H {fmtPrice(shown.high, assetId)}</span>
          <span>L {fmtPrice(shown.low, assetId)}</span>
          <span>C {fmtPrice(shown.close, assetId)}</span>
          <span className={chg >= 0 ? "text-bull" : "text-bear"}>{chg >= 0 ? "+" : ""}{chg.toFixed(2)}%</span>
          {idx >= 0 && overlays.ema20 && Number.isFinite(computed.e20[idx]) && <span style={{ color: "var(--series-1)" }}>EMA20 {fmtPrice(computed.e20[idx], assetId)}</span>}
          {idx >= 0 && overlays.ema50 && Number.isFinite(computed.e50[idx]) && <span style={{ color: "var(--series-2)" }}>EMA50 {fmtPrice(computed.e50[idx], assetId)}</span>}
          {idx >= 0 && overlays.ema200 && Number.isFinite(computed.e200[idx]) && <span style={{ color: "var(--series-4)" }}>EMA200 {fmtPrice(computed.e200[idx], assetId)}</span>}
          {idx >= 0 && overlays.vwap && Number.isFinite(computed.vw[idx]) && <span className="text-accent">VWAP {fmtPrice(computed.vw[idx], assetId)}</span>}
        </div>
      )}
      <div ref={mainRef} className="w-full" style={{ height }} />
      {showIndicators && (
        <>
          <div className="relative border-t border-line">
            <span className="absolute left-2 top-1 z-10 text-[10.5px] text-ink-3">RSI 14</span>
            <div ref={rsiRef} className="w-full" style={{ height: 110 }} />
          </div>
          <div className="relative border-t border-line">
            <span className="absolute left-2 top-1 z-10 text-[10.5px] text-ink-3">MACD 12·26·9</span>
            <div ref={macdRef} className="w-full" style={{ height: 110 }} />
          </div>
        </>
      )}
    </div>
  );
}

export function OverlayToolbar({ value, onChange }: { value: OverlayToggles; onChange: (v: OverlayToggles) => void }) {
  const items: { key: keyof OverlayToggles; label: string; color?: string }[] = [
    { key: "ema20", label: "EMA 20", color: "var(--series-1)" },
    { key: "ema50", label: "EMA 50", color: "var(--series-2)" },
    { key: "ema100", label: "EMA 100", color: "var(--series-7)" },
    { key: "ema200", label: "EMA 200", color: "var(--series-4)" },
    { key: "bb", label: "Bollinger", color: "var(--series-3)" },
    { key: "vwap", label: "VWAP", color: "var(--accent)" },
    { key: "volume", label: "Volume" },
    { key: "levels", label: "Levels" },
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((it) => (
        <button key={it.key} onClick={() => onChange({ ...value, [it.key]: !value[it.key] })} aria-pressed={value[it.key]} className={cls("inline-flex items-center gap-1.5 rounded-md border px-2 h-7 text-[11px] font-medium transition-colors", value[it.key] ? "border-line bg-surface-3 text-ink-1" : "border-transparent text-ink-3 hover:text-ink-1")}>
          {it.color && <span className="h-2 w-2 rounded-full" style={{ background: it.color, opacity: value[it.key] ? 1 : 0.4 }} />}
          {it.label}
        </button>
      ))}
    </div>
  );
}

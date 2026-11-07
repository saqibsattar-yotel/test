/**
 * Aggregates Binance USDⓈ-M forced liquidation orders from the public
 * `!forceOrder@arr` stream into per-minute buckets. Data exists only since the server
 * started — the payload says so explicitly.
 */
import WebSocket from "ws";
import { logger } from "../lib/logger";

const log = logger("liquidations");

interface Bucket {
  minute: number; // epoch ms floored to minute
  longUsd: number; // longs liquidated (SELL side force orders)
  shortUsd: number;
  count: number;
}

export interface LiquidationEvent {
  time: number;
  symbol: string;
  side: "LONG" | "SHORT";
  price: number;
  qty: number;
  usd: number;
}

class LiquidationAggregator {
  private buckets = new Map<string, Map<number, Bucket>>();
  private recent: LiquidationEvent[] = [];
  private ws: WebSocket | null = null;
  private startedAt = 0;
  private connected = false;
  private reconnectDelay = 2000;
  private tracked = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT"]);

  /** Add perpetual symbols to the tracked set (top market caps on registry load, plus anything the UI opens). */
  track(symbols: string[]) {
    for (const s of symbols) if (s && s !== "PAXGUSDT") this.tracked.add(s);
    if (this.tracked.size > 150) {
      // keep memory bounded: drop the oldest-added extras beyond the cap
      const extras = [...this.tracked].slice(0, this.tracked.size - 150);
      for (const e of extras) this.tracked.delete(e);
    }
  }
  trackedCount() {
    return this.tracked.size;
  }

  start() {
    if (this.ws) return;
    this.startedAt = Date.now();
    this.connect();
  }

  private connect() {
    try {
      const ws = new WebSocket("wss://fstream.binance.com/ws/!forceOrder@arr");
      this.ws = ws;
      ws.on("open", () => {
        this.connected = true;
        this.reconnectDelay = 2000;
        log.info("connected to Binance forceOrder stream");
      });
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { o?: { s: string; S: string; p: string; q: string; T: number } };
          const o = msg.o;
          if (!o || !this.tracked.has(o.s)) return;
          const price = parseFloat(o.p);
          const qty = parseFloat(o.q);
          const usd = price * qty;
          // SELL force order = a long position being liquidated.
          const side: "LONG" | "SHORT" = o.S === "SELL" ? "LONG" : "SHORT";
          const minute = Math.floor(o.T / 60_000) * 60_000;
          let m = this.buckets.get(o.s);
          if (!m) {
            m = new Map();
            this.buckets.set(o.s, m);
          }
          let b = m.get(minute);
          if (!b) {
            b = { minute, longUsd: 0, shortUsd: 0, count: 0 };
            m.set(minute, b);
          }
          if (side === "LONG") b.longUsd += usd;
          else b.shortUsd += usd;
          b.count++;
          this.recent.unshift({ time: o.T, symbol: o.s, side, price, qty, usd });
          if (this.recent.length > 200) this.recent.length = 200;
          const cutoff = Date.now() - 25 * 3_600_000;
          for (const [k] of m) if (k < cutoff) m.delete(k);
        } catch {
          /* ignore malformed */
        }
      });
      const retry = () => {
        this.connected = false;
        this.ws = null;
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(60_000, this.reconnectDelay * 2);
      };
      ws.on("close", retry);
      ws.on("error", (err) => {
        log.warn(`forceOrder stream error: ${err.message}`);
        ws.close();
      });
    } catch (err) {
      log.warn(`forceOrder connect failed: ${(err as Error).message}`);
    }
  }

  summary(windowMs = 24 * 3_600_000) {
    const since = Date.now() - windowMs;
    const perSymbol: Record<string, { longUsd: number; shortUsd: number; count: number }> = {};
    let totalLong = 0;
    let totalShort = 0;
    const timeline = new Map<number, { time: number; longUsd: number; shortUsd: number }>();
    for (const [sym, m] of this.buckets) {
      for (const b of m.values()) {
        if (b.minute < since) continue;
        const p = (perSymbol[sym] ??= { longUsd: 0, shortUsd: 0, count: 0 });
        p.longUsd += b.longUsd;
        p.shortUsd += b.shortUsd;
        p.count += b.count;
        totalLong += b.longUsd;
        totalShort += b.shortUsd;
        const hour = Math.floor(b.minute / 3_600_000) * 3_600_000;
        const t = timeline.get(hour) ?? { time: hour, longUsd: 0, shortUsd: 0 };
        t.longUsd += b.longUsd;
        t.shortUsd += b.shortUsd;
        timeline.set(hour, t);
      }
    }
    const largest = [...this.recent].sort((a, b) => b.usd - a.usd).slice(0, 10);
    return {
      connected: this.connected,
      since: this.startedAt,
      coverageMs: this.startedAt ? Date.now() - this.startedAt : 0,
      totalLongUsd: totalLong,
      totalShortUsd: totalShort,
      perSymbol,
      timeline: [...timeline.values()].sort((a, b) => a.time - b.time),
      largest,
      recent: this.recent.slice(0, 30),
      source: { provider: "binance-futures", label: "Binance USDⓈ-M forced-liquidation stream (!forceOrder@arr)", fetchedAt: Date.now(), asOf: Date.now(), quality: this.connected ? ("live" as const) : ("unavailable" as const), note: "Aggregated locally since server start; Binance publishes at most one force order per symbol per second, so totals understate true liquidation volume." },
    };
  }
}

export const liquidations = new LiquidationAggregator();

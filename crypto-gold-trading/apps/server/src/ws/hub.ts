/**
 * Client WebSocket hub. One upstream Binance combined stream fans miniTicker updates out to
 * browser clients as normalised `quote` messages; alerts and status ride the same channel.
 * Subscriptions are dynamic: the core majors are always on, and any asset a client opens
 * (candles, analysis, setups, or an explicit `subscribe` message) is added on demand and
 * dropped again after two idle hours. If the upstream stream dies the hub falls back to
 * REST polling and marks quotes as "delayed".
 */
import WebSocket from "ws";
import type { AssetId, Quote } from "@terminal/core";
import { CRYPTO_ASSETS, METAL_ASSETS, isMetalAsset } from "@terminal/core";
import { assetIdsForBinanceSymbol, binanceSymbol } from "../providers/binance";
import { logger } from "../lib/logger";
import { market } from "../services/market";
import { liquidations } from "../services/liquidations";
import { config } from "../config";

const log = logger("ws");

export type HubMessage = { type: "quote"; quote: Quote } | { type: "quotes"; quotes: Quote[] } | { type: "alert"; alert: unknown } | { type: "status"; upstream: "live" | "polling" | "demo"; clients: number; streams: number } | { type: "liquidation"; event: unknown } | { type: "monitor"; item: unknown };

type Client = { send: (data: string) => void; readyState: number };

const CORE: AssetId[] = [...CRYPTO_ASSETS, ...METAL_ASSETS];
const MAX_STREAMS = 400;
const IDLE_MS = 2 * 3_600_000;

class Hub {
  private clients = new Set<Client>();
  private upstream: WebSocket | null = null;
  private upstreamLive = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private latest = new Map<AssetId, Quote>();
  private reconnectDelay = 2000;
  /** asset id -> last time something asked for it (core assets never expire). */
  private tracked = new Map<AssetId, number>(CORE.map((a) => [a, Infinity]));
  private subscribed = new Set<string>();
  private msgId = 1;

  addClient(c: Client) {
    this.clients.add(c);
    c.send(JSON.stringify({ type: "status", upstream: this.status(), clients: this.clients.size, streams: this.subscribed.size } satisfies HubMessage));
    if (this.latest.size) c.send(JSON.stringify({ type: "quotes", quotes: [...this.latest.values()] } satisfies HubMessage));
  }
  removeClient(c: Client) {
    this.clients.delete(c);
  }
  status(): "live" | "polling" | "demo" {
    if (config.DEMO_MODE === "force") return "demo";
    return this.upstreamLive ? "live" : "polling";
  }
  broadcast(msg: HubMessage) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.readyState === 1) {
        try {
          c.send(data);
        } catch {
          /* drop */
        }
      }
    }
  }
  latestQuotes(): Quote[] {
    return [...this.latest.values()];
  }
  trackedAssets(): AssetId[] {
    return [...this.tracked.keys()];
  }

  /** Make sure quotes for these assets are streamed (idempotent, cheap). */
  ensureSubscribed(assetIds: AssetId[]) {
    const now = Date.now();
    const added: string[] = [];
    for (const id of assetIds) {
      const sym = binanceSymbol(id);
      if (!sym) continue;
      if (!this.tracked.has(id)) {
        if (this.tracked.size >= MAX_STREAMS) this.evictIdle(true);
        if (this.tracked.size >= MAX_STREAMS) continue;
        this.tracked.set(id, now);
        added.push(sym);
      } else if (this.tracked.get(id) !== Infinity) this.tracked.set(id, now);
    }
    if (added.length) {
      liquidations.track(added);
      this.subscribeStreams(added);
      // Seed a REST quote immediately so the UI does not wait for the first tick.
      void market
        .getQuotes(assetIds.filter((a) => !this.latest.has(a)))
        .then((qs) => {
          for (const q of qs) this.latest.set(q.assetId, q);
          if (qs.length) this.broadcast({ type: "quotes", quotes: qs });
        })
        .catch(() => undefined);
    }
  }

  private subscribeStreams(symbols: string[]) {
    const streams = symbols.map((s) => `${s.toLowerCase()}@miniTicker`).filter((s) => !this.subscribed.has(s));
    for (const s of streams) this.subscribed.add(s);
    if (!streams.length || !this.upstream || this.upstream.readyState !== WebSocket.OPEN) return;
    this.upstream.send(JSON.stringify({ method: "SUBSCRIBE", params: streams, id: this.msgId++ }));
  }

  private evictIdle(force = false) {
    const now = Date.now();
    const victims: AssetId[] = [];
    for (const [id, t] of this.tracked) if (t !== Infinity && (force || now - t > IDLE_MS)) victims.push(id);
    if (!victims.length) return;
    const streams: string[] = [];
    for (const id of victims) {
      this.tracked.delete(id);
      this.latest.delete(id);
      const s = `${binanceSymbol(id)!.toLowerCase()}@miniTicker`;
      if (this.subscribed.delete(s)) streams.push(s);
    }
    if (streams.length && this.upstream && this.upstream.readyState === WebSocket.OPEN) this.upstream.send(JSON.stringify({ method: "UNSUBSCRIBE", params: streams, id: this.msgId++ }));
    log.info(`unsubscribed ${victims.length} idle asset stream(s)`);
  }

  start() {
    for (const id of CORE) {
      const s = binanceSymbol(id);
      if (s) this.subscribed.add(`${s.toLowerCase()}@miniTicker`);
    }
    this.startPolling();
    if (config.DEMO_MODE !== "force") this.connectUpstream();
    this.sweepTimer = setInterval(() => this.evictIdle(), 10 * 60_000);
  }

  private connectUpstream() {
    const url = `wss://stream.binance.com:9443/stream?streams=${[...this.subscribed].join("/")}`;
    try {
      const ws = new WebSocket(url);
      this.upstream = ws;
      ws.on("open", () => {
        this.upstreamLive = true;
        this.reconnectDelay = 2000;
        log.info(`upstream miniTicker stream connected (${this.subscribed.size} streams)`);
        this.broadcast({ type: "status", upstream: this.status(), clients: this.clients.size, streams: this.subscribed.size });
      });
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { data?: { s: string; c: string; o: string; h: string; l: string; v: string; q: string; E: number } };
          const d = msg.data;
          if (!d) return;
          const price = parseFloat(d.c);
          const open = parseFloat(d.o);
          for (const assetId of assetIdsForBinanceSymbol(d.s)) {
            if (!this.tracked.has(assetId)) continue;
            const quote: Quote = {
              assetId,
              price,
              change24h: price - open,
              changePct24h: open ? ((price - open) / open) * 100 : 0,
              high24h: parseFloat(d.h),
              low24h: parseFloat(d.l),
              volume24hBase: parseFloat(d.v),
              volume24hQuote: parseFloat(d.q),
              source: { provider: "binance", label: `Binance ${d.s} stream`, fetchedAt: Date.now(), asOf: d.E, quality: "live", proxy: false, note: d.s === "PAXGUSDT" ? "Tokenised gold (PAXG) on a crypto venue — not spot XAU/USD." : "24h rolling window mini-ticker." },
            };
            this.latest.set(assetId, quote);
            this.broadcast({ type: "quote", quote });
          }
        } catch {
          /* ignore */
        }
      });
      const retry = () => {
        if (this.upstreamLive) log.warn("upstream stream closed; falling back to REST polling");
        this.upstreamLive = false;
        this.upstream = null;
        this.broadcast({ type: "status", upstream: this.status(), clients: this.clients.size, streams: this.subscribed.size });
        setTimeout(() => this.connectUpstream(), this.reconnectDelay);
        this.reconnectDelay = Math.min(60_000, this.reconnectDelay * 2);
      };
      ws.on("close", retry);
      ws.on("error", (err) => {
        log.warn(`upstream error: ${err.message}`);
        ws.close();
      });
    } catch (err) {
      log.warn(`upstream connect failed: ${(err as Error).message}`);
    }
  }

  private startPolling() {
    const poll = async () => {
      try {
        const all = this.trackedAssets();
        // Spot gold and silver have no exchange stream: always poll them (Swissquote / Twelve Data) alongside anything the stream is not covering.
        const need = this.upstreamLive ? all.filter(isMetalAsset) : all;
        if (!need.length) return;
        const quotes = await market.getQuotes(need);
        for (const q of quotes) {
          const prev = this.latest.get(q.assetId);
          // The metals never come from the exchange stream, so a polled spot quote always wins.
          if (!this.upstreamLive || !prev || isMetalAsset(q.assetId) || prev.source.quality === "demo") {
            const quality = !this.upstreamLive && q.source.quality === "live" ? "delayed" : q.source.quality;
            this.latest.set(q.assetId, { ...q, source: { ...q.source, quality } });
          }
        }
        this.broadcast({ type: "quotes", quotes: [...this.latest.values()] });
      } catch (err) {
        log.warn(`poll failed: ${(err as Error).message}`);
      }
    };
    void poll();
    this.pollTimer = setInterval(poll, 10_000);
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.upstream?.close();
  }
}

export const hub = new Hub();

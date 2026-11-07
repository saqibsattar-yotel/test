/**
 * Live setup monitoring: applies streamed prices to tracked plans, persists every
 * transition, pushes one alert per event (never twice — each transition exists once in the
 * record's event list), and keeps finished plans as history. Nothing here places orders.
 */
import type { TradeSetup } from "@terminal/core";
import { applyPrice, cancelMonitored, closeMonitored, createMonitored, hashString, monitorSummary, type MonitoredSetup, type MonitorEvent } from "@terminal/core";
import { JsonStore } from "../lib/store";
import { logger } from "../lib/logger";
import { hub } from "../ws/hub";
import { userStore, getSettings, type TriggeredAlert } from "./user";
import { getSetupsFor } from "./analysis";

const log = logger("monitor");

interface MonitorState {
  items: MonitoredSetup[];
}

/** A regenerated plan with the same asset, timeframe, direction and (within 0.1 %) the same entry and stop is the same plan. */
export function isSamePlan(m: MonitoredSetup, setup: TradeSetup): boolean {
  if (m.assetId !== setup.assetId || m.timeframe !== setup.timeframe || m.direction !== setup.direction || m.setup.setupType !== setup.setupType) return false;
  const near = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) / Math.max(Math.abs(a), 1e-9) < 0.001;
  return near(m.setup.entry.mid, setup.entry.mid) && near(m.setup.stopLoss, setup.stopLoss);
}

class MonitorService {
  private store = new JsonStore<MonitorState>("monitor", () => ({ items: [] }));
  private timer: NodeJS.Timeout | null = null;
  private autoTimer: NodeJS.Timeout | null = null;
  private busy = false;

  start() {
    this.timer = setInterval(() => void this.tick(), 3_000);
    this.autoTimer = setInterval(() => void this.autoTrack(), 5 * 60_000);
    setTimeout(() => void this.autoTrack(), 20_000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.autoTimer) clearInterval(this.autoTimer);
  }

  async list() {
    const s = await this.store.load();
    const active = s.items.filter((m) => !m.final).sort((a, b) => b.createdAt - a.createdAt);
    const history = s.items.filter((m) => m.final).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
    return { active, history, summary: monitorSummary(s.items) };
  }

  async track(setup: TradeSetup, source: MonitoredSetup["source"] = "saved"): Promise<{ item: MonitoredSetup; created: boolean }> {
    const s = await this.store.load();
    const existing = s.items.find((m) => !m.final && (m.setupId === setup.id || isSamePlan(m, setup)));
    if (existing) return { item: existing, created: false };
    const item = createMonitored(setup, Date.now(), source);
    await this.store.update((st) => ({ items: [item, ...st.items].slice(0, 500) }));
    hub.ensureSubscribed([setup.assetId]);
    log.info(`tracking ${setup.symbol} ${setup.direction} ${setup.timeframe} (${source})`);
    return { item, created: true };
  }

  async cancel(id: string): Promise<MonitoredSetup | null> {
    let out: MonitoredSetup | null = null;
    await this.store.update((st) => {
      st.items = st.items.map((m) => {
        if (m.id !== id) return m;
        out = cancelMonitored(m, Date.now());
        return out;
      });
      return st;
    });
    return out;
  }

  async close(id: string, price?: number): Promise<MonitoredSetup | null> {
    let out: MonitoredSetup | null = null;
    await this.store.update((st) => {
      st.items = st.items.map((m) => {
        if (m.id !== id) return m;
        const p = price ?? hub.latestQuotes().find((q) => q.assetId === m.assetId)?.price ?? m.lastPrice ?? m.setup.currentPrice;
        out = closeMonitored(m, p, Date.now());
        return out;
      });
      return st;
    });
    return out;
  }

  async remove(id: string): Promise<boolean> {
    let removed = false;
    await this.store.update((st) => {
      const before = st.items.length;
      st.items = st.items.filter((m) => m.id !== id || !m.final);
      removed = st.items.length < before;
      return st;
    });
    return removed;
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const s = await this.store.load();
      const active = s.items.filter((m) => !m.final);
      if (!active.length) return;
      const quotes = new Map(hub.latestQuotes().map((q) => [q.assetId, q]));
      const now = Date.now();
      const fired: { item: MonitoredSetup; events: MonitorEvent[] }[] = [];
      let changed = false;
      const next = s.items.map((m) => {
        if (m.final) return m;
        const q = quotes.get(m.assetId);
        if (!q || q.source.quality === "demo" || q.source.quality === "unavailable") return m;
        try {
          const { next: updated, newEvents } = applyPrice(m, q.price, Math.min(now, Math.max(q.source.asOf, now - 60_000)));
          if (newEvents.length) fired.push({ item: updated, events: newEvents });
          if (updated !== m) changed = true;
          return updated;
        } catch (err) {
          // One malformed plan must never stall the others: park it with a note instead of aborting the tick.
          const message = `monitor error: ${(err as Error).message}`;
          if (m.note !== message) log.warn(`${m.symbol} ${m.id}: ${message}`);
          changed = changed || m.note !== message;
          return { ...m, note: message, lastCheckedAt: now };
        }
      });
      if (changed) await this.store.save({ items: next });
      for (const f of fired) for (const e of f.events) await this.alert(f.item, e);
    } catch (err) {
      log.warn(`tick failed: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async alert(item: MonitoredSetup, e: MonitorEvent) {
    const t: TriggeredAlert = { id: `tr_${hashString(`${item.id}:${e.id}`)}`, ruleId: `monitor:${item.id}`, kind: "setup_monitor", assetId: item.assetId, message: e.message, value: e.price, time: e.time, read: false };
    await userStore.update((st) => {
      if (st.triggered.some((x) => x.id === t.id)) return st; // dedupe on restart/race
      st.triggered.unshift(t);
      if (st.triggered.length > 300) st.triggered.length = 300;
      return st;
    });
    hub.broadcast({ type: "alert", alert: t });
    hub.broadcast({ type: "monitor", item });
    log.info(`monitor event: ${e.type} ${item.symbol} @ ${e.price}`);
  }

  /** Optionally track every actionable setup for followed assets (Settings → autoMonitorSetups). */
  private async autoTrack() {
    try {
      const settings = await getSettings();
      if (!settings.autoMonitorSetups) return;
      const { setups } = await getSetupsFor(settings.followedAssets, settings.defaultTimeframe);
      const actionable = setups.filter((x) => ["STRONG LONG", "LONG", "SHORT", "STRONG SHORT"].includes(x.status));
      const s = await this.store.load();
      const activeCount = s.items.filter((m) => !m.final && m.source === "auto").length;
      for (const x of actionable) {
        if (activeCount >= 20) break;
        const dup = s.items.find((m) => !m.final && m.assetId === x.assetId && m.timeframe === x.timeframe && m.direction === x.direction);
        if (!dup) await this.track(x, "auto");
      }
    } catch (err) {
      log.warn(`auto-track failed: ${(err as Error).message}`);
    }
  }
}

export const monitor = new MonitorService();

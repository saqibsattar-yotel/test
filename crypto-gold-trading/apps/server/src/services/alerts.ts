/**
 * Alert evaluation loop: price alerts on every quote tick, setup/regime alerts on a
 * slower cadence. Triggered alerts are persisted and pushed over the WebSocket hub.
 */
import type { Quote, AssetId, TradeSetup } from "@terminal/core";
import { hashString } from "@terminal/core";
import { logger } from "../lib/logger";
import { hub } from "../ws/hub";
import { userStore, type AlertRule, type TriggeredAlert } from "./user";
import { getCryptoRegime, getGoldRegime, getSetupsFor } from "./analysis";

const log = logger("alerts");

class AlertService {
  private lastRegime: Record<string, string> = {};
  private lastSetupStatus: Record<string, string> = {};
  private timer: NodeJS.Timeout | null = null;

  start() {
    this.timer = setInterval(() => void this.tick(), 15_000);
    setTimeout(() => void this.tick(), 5_000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async fire(rule: AlertRule, message: string, value?: number) {
    const now = Date.now();
    const t: TriggeredAlert = { id: `tr_${hashString(`${rule.id}${now}`)}`, ruleId: rule.id, kind: rule.kind, assetId: rule.assetId, message, value, time: now, read: false };
    await userStore.update((s) => {
      const r = s.alerts.find((a) => a.id === rule.id);
      if (r) {
        r.lastTriggeredAt = now;
        r.triggerCount++;
        if (r.kind === "price_above" || r.kind === "price_below") r.active = false; // one-shot
      }
      s.triggered.unshift(t);
      if (s.triggered.length > 200) s.triggered.length = 200;
      return s;
    });
    hub.broadcast({ type: "alert", alert: t });
    log.info(`alert fired: ${message}`);
  }

  async evaluatePrices(quotes: Quote[]) {
    const state = await userStore.load();
    for (const rule of state.alerts) {
      if (!rule.active || !rule.assetId || rule.level === undefined) continue;
      const q = quotes.find((x) => x.assetId === rule.assetId);
      if (!q || q.source.quality === "demo") continue;
      if (rule.kind === "price_above" && q.price >= rule.level) await this.fire(rule, `${q.assetId} crossed above ${rule.level} (now ${q.price})`, q.price);
      if (rule.kind === "price_below" && q.price <= rule.level) await this.fire(rule, `${q.assetId} crossed below ${rule.level} (now ${q.price})`, q.price);
    }
  }

  private async tick() {
    try {
      await this.evaluatePrices(hub.latestQuotes());
      const state = await userStore.load();
      const regimeRules = state.alerts.filter((a) => a.active && a.kind === "regime_change");
      if (regimeRules.length) {
        const [c, g] = await Promise.allSettled([getCryptoRegime(), getGoldRegime()]);
        const zones: Record<string, string> = {};
        if (c.status === "fulfilled") zones.crypto = c.value.result.zone;
        if (g.status === "fulfilled") zones.gold = g.value.result.zone;
        for (const [k, z] of Object.entries(zones)) {
          if (this.lastRegime[k] && this.lastRegime[k] !== z) for (const r of regimeRules) await this.fire(r, `${k === "crypto" ? "Crypto regime" : "Gold posture"} changed ${this.lastRegime[k]} → ${z}`);
          this.lastRegime[k] = z;
        }
      }
      const setupRules = state.alerts.filter((a) => a.active && a.kind === "setup_status");
      if (setupRules.length) {
        const byTf = new Map<string, AssetId[]>();
        for (const r of setupRules) {
          const tf = r.timeframe ?? "4h";
          const list = byTf.get(tf) ?? [];
          if (r.assetId && !list.includes(r.assetId)) list.push(r.assetId);
          byTf.set(tf, list);
        }
        for (const [tf, assets] of byTf) {
          if (!assets.length) continue;
          const { setups } = await getSetupsFor(assets, tf as TradeSetup["timeframe"]);
          for (const s of setups) {
            const key = `${s.assetId}:${tf}`;
            const prev = this.lastSetupStatus[key];
            this.lastSetupStatus[key] = s.status;
            if (prev === undefined || prev === s.status) continue;
            for (const r of setupRules.filter((x) => x.assetId === s.assetId && (x.timeframe ?? "4h") === tf)) {
              const want = r.statuses?.length ? r.statuses : ["STRONG LONG", "STRONG SHORT", "LONG", "SHORT"];
              if (want.includes(s.status)) await this.fire(r, `${s.symbol} ${tf}: setup status is now ${s.status} (quality ${s.qualityScore})`, s.qualityScore);
            }
          }
        }
      }
    } catch (err) {
      log.warn(`alert tick failed: ${(err as Error).message}`);
    }
  }
}

export const alerts = new AlertService();

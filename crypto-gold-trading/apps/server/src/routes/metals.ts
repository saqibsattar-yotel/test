/**
 * Routes of the precious-metals workspaces. Gold and silver expose the same endpoints under
 * /api/market/gold/… and /api/market/silver/…; the dollar index is shared by both.
 */
import type { FastifyInstance } from "fastify";
import { METALS, METAL_ASSETS, type Metal } from "@terminal/core";
import { isWarming } from "../lib/warming";
import { market } from "../services/market";
import { getDxy, getGoldSilverRatio, getInstrumentCandles, getMetalVerification, getWarmupStatus, liveSampler } from "../services/metals";

const TRADES_WHEN = "Sunday ~22:00 UTC to Friday ~22:00 UTC with a daily break around 22:00 UTC";

/** The exchange-traded contract of each metal. No price is shown for it: that needs a licensed feed. */
const FUTURES: Record<Metal, { kind: string; note: string }> = {
  gold: {
    kind: "COMEX gold futures (GC) — 100 troy oz, $0.10 tick = $10; MGC micro 10 oz",
    note: "Live GC quotes need a licensed futures feed (e.g. a Twelve Data/CME-enabled plan). Contract specifications are available in the Risk Calculator; no price is fabricated here.",
  },
  silver: {
    kind: "COMEX silver futures (SI) — 5,000 troy oz, $0.005 tick = $25; SIL micro 1,000 oz",
    note: "Live SI quotes need a licensed futures feed (e.g. a Twelve Data/CME-enabled plan). Contract specifications are available in the Risk Calculator; no price is fabricated here.",
  },
};

export async function metalRoutes(app: FastifyInstance) {
  app.get("/api/market/dxy", async () => {
    const d = await getDxy();
    return { value: d.value, ts: d.ts, quality: d.quality, source: d.source, components: d.components, archiveLastClose: d.archiveLastClose, computedVsArchivePct: d.computedVsArchivePct, history1h: d.history1h.slice(-300), history1d: d.history1d.slice(-400), warming: d.historyWarming, archive: getWarmupStatus().archive.other };
  });

  app.get("/api/market/metals/ratio", async () => getGoldSilverRatio());

  for (const id of METAL_ASSETS) {
    const { metal, pair } = METALS[id];

    app.get(`/api/market/${metal}/verification`, async () => getMetalVerification(id));

    app.get(`/api/market/${metal}/instruments`, async () => {
      // PAX Gold is the one liquid tokenised metal on the venues this terminal reads; silver has no counterpart.
      const [spot, paxg, archiveDaily, ratio] = await Promise.allSettled([market.getQuotes([id]), metal === "gold" ? market.getQuotes(["PAXGUSD"]) : Promise.resolve([]), getInstrumentCandles(id, "1d", 2), getGoldSilverRatio()]);
      const s = spot.status === "fulfilled" ? (spot.value[0] ?? null) : null;
      const p = paxg.status === "fulfilled" ? (paxg.value[0] ?? null) : null;
      const prev = archiveDaily.status === "fulfilled" && archiveDaily.value.length ? archiveDaily.value[archiveDaily.value.length - 1] : null;
      return {
        metal,
        spot: s ? { quote: s, kind: `Spot ${pair} (OTC, London/global interbank)`, tradesWhen: TRADES_WHEN } : null,
        tokenized: p ? { quote: p, kind: "PAX Gold (PAXG) — ERC-20 token backed by vaulted gold, traded on crypto venues 24/7", premiumVsSpotPct: s ? ((p.price - s.price) / s.price) * 100 : null } : null,
        futures: { ...FUTURES[metal], quote: null },
        ratio: ratio.status === "fulfilled" ? ratio.value : null,
        archiveLastDaily: prev,
        sampler: { lastSampleAt: liveSampler.lastSampleAt[id], lastError: liveSampler.lastError },
        warming: (spot.status === "fulfilled" && !s) || (archiveDaily.status === "rejected" && isWarming(archiveDaily.reason)),
      };
    });
  }
}

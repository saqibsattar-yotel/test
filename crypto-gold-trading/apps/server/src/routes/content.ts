import type { FastifyInstance } from "fastify";
import type { EconEvent } from "@terminal/core";
import { cache } from "../lib/cache";
import { loadForexFactoryWeek, loadOfficialSchedule, mergeEvents } from "../providers/calendar";
import { fetchAllNews, FEEDS, type NewsItem, type NewsTopic } from "../providers/news";

export async function getCalendar(from: number, to: number): Promise<{ events: EconEvent[]; sources: { provider: string; label: string; official: boolean; error?: string }[] }> {
  const res = await cache.getOrLoad("calendar:all", 60 * 60_000, async () => {
    const sources: { provider: string; label: string; official: boolean; error?: string }[] = [{ provider: "official-schedule", label: "Fed / BLS / BEA published release schedules (data/official-schedule.json)", official: true }];
    const official = await loadOfficialSchedule();
    let feed: EconEvent[] = [];
    try {
      feed = await loadForexFactoryWeek();
      if (feed.length) sources.push({ provider: "forexfactory", label: "Forex Factory weekly feed (forecast / previous values)", official: false });
    } catch (err) {
      sources.push({ provider: "forexfactory", label: "Forex Factory weekly feed", official: false, error: (err as Error).message });
    }
    return { events: mergeEvents(official, feed), sources };
  });
  return { events: res.value.events.filter((e) => e.time >= from && e.time <= to), sources: res.value.sources };
}

export async function getNews(topic: NewsTopic | "all"): Promise<{ items: NewsItem[]; failed: string[]; fetchedAt: number; feeds: { publisher: string; topics: NewsTopic[] }[] }> {
  const res = await cache.getOrLoad("news:all", 10 * 60_000, fetchAllNews);
  const items = topic === "all" ? res.value.items : res.value.items.filter((i) => i.topics.includes(topic));
  return { items, failed: res.value.failed, fetchedAt: res.storedAt, feeds: FEEDS.map((f) => ({ publisher: f.publisher, topics: f.topics })) };
}

export async function contentRoutes(app: FastifyInstance) {
  app.get("/api/calendar", async (req) => {
    const q = req.query as { from?: string; to?: string; markets?: string; importance?: string };
    const now = Date.now();
    const from = q.from ? Date.parse(q.from) : now - 2 * 86_400_000;
    const to = q.to ? Date.parse(q.to) : now + 30 * 86_400_000;
    const cal = await getCalendar(Number.isFinite(from) ? from : now - 2 * 86_400_000, Number.isFinite(to) ? to : now + 30 * 86_400_000);
    let events = cal.events;
    if (q.markets) {
      const want = q.markets.split(",").map((s) => s.trim());
      events = events.filter((e) => e.relatedMarkets.some((m) => want.includes(m)));
    }
    if (q.importance) {
      const want = q.importance.split(",").map((s) => s.trim());
      events = events.filter((e) => want.includes(e.importance));
    }
    return { events, sources: cal.sources, generatedAt: Date.now(), note: "Forecast and actual values are shown only when supplied by a data provider; they are never estimated." };
  });

  app.get("/api/news", async (req) => {
    const q = req.query as { topic?: string; limit?: string };
    const topic = (["crypto", "gold", "macro"].includes(q.topic ?? "") ? q.topic : "all") as NewsTopic | "all";
    const res = await getNews(topic);
    const limit = Math.min(200, Math.max(1, parseInt(q.limit ?? "60", 10) || 60));
    return { ...res, items: res.items.slice(0, limit) };
  });
}

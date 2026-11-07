/**
 * Economic calendar providers.
 *  - Official schedule (data/official-schedule.json): dates published by the Fed, BLS
 *    and BEA. Official = true. Never carries forecasts/actuals.
 *  - Forex Factory weekly feed (nfs.faireconomy.media): current week, with forecast and
 *    previous values where the feed supplies them. Can be disabled via CALENDAR_FF_FEED.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { EconEvent, Importance } from "@terminal/core";
import { normalizeImportance, tagRelevance, zonedTimeToUtc, hashString } from "@terminal/core";
import { config, repoRoot } from "../config";
import { fetchJson } from "../lib/http";

interface OfficialEntry {
  title: string;
  agency: string;
  date: string;
  time: string;
  importance: Importance;
  url: string;
  sep?: boolean;
  tentative?: boolean;
}

export async function loadOfficialSchedule(): Promise<EconEvent[]> {
  const candidates = [path.join(config.dataDir, "official-schedule.json"), path.join(repoRoot, "data/official-schedule.json")];
  let raw: string | null = null;
  for (const p of candidates) {
    try {
      raw = await fs.readFile(p, "utf8");
      break;
    } catch {
      /* try next */
    }
  }
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { events: OfficialEntry[] };
  return parsed.events.map((e) => {
    const [h, m] = e.time.split(":").map(Number);
    const [y, mo, d] = e.date.split("-").map(Number);
    const time = zonedTimeToUtc({ year: y, month: mo, day: d, hour: h, minute: m }, "America/New_York");
    const tags = tagRelevance(e.title, "USD", e.importance);
    const title = `${e.title}${e.sep ? " (with Summary of Economic Projections)" : ""}${e.tentative ? " — tentative" : ""}`;
    return {
      id: `official_${hashString(`${e.title}${e.date}${e.time}`)}`,
      title,
      country: "USD",
      time,
      importance: tags.importance,
      previous: null,
      forecast: null,
      actual: null,
      source: { provider: "official-schedule", label: `${e.agency} published schedule`, url: e.url },
      official: true,
      relatedMarkets: tags.relatedMarkets,
      whyItMatters: tags.whyItMatters,
    } satisfies EconEvent;
  });
}

interface FfEvent {
  title: string;
  country: string;
  date: string;
  impact: string;
  forecast: string;
  previous: string;
  actual?: string;
}

export async function loadForexFactoryWeek(): Promise<EconEvent[]> {
  if (!config.CALENDAR_FF_FEED) return [];
  const url = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
  const list = await fetchJson<FfEvent[]>(url, { timeoutMs: 15_000 });
  return list
    .map((e): EconEvent | null => {
      const time = Date.parse(e.date);
      if (!Number.isFinite(time)) return null;
      const imp = normalizeImportance(e.impact);
      const tags = tagRelevance(e.title, e.country, imp);
      return {
        id: `ff_${hashString(`${e.title}${e.country}${e.date}`)}`,
        title: e.title,
        country: e.country,
        time,
        allDay: imp === "holiday",
        importance: tags.importance,
        previous: e.previous || null,
        forecast: e.forecast || null,
        actual: e.actual || null,
        source: { provider: "forexfactory", label: "Forex Factory weekly calendar feed", url: "https://www.forexfactory.com/calendar" },
        official: false,
        relatedMarkets: tags.relatedMarkets,
        whyItMatters: tags.whyItMatters,
      };
    })
    .filter((e): e is EconEvent => e !== null);
}

/** Merge: when an official entry and a feed entry describe the same release, keep both sources but de-duplicate by (title-ish, time ±1h). */
export function mergeEvents(official: EconEvent[], feed: EconEvent[]): EconEvent[] {
  const out = [...official];
  for (const f of feed) {
    const dup = official.find((o) => Math.abs(o.time - f.time) <= 60 * 60_000 && sameRelease(o.title, f.title));
    if (dup) {
      dup.forecast = f.forecast ?? dup.forecast;
      dup.previous = f.previous ?? dup.previous;
      dup.actual = f.actual ?? dup.actual;
      dup.source = { ...dup.source, label: `${dup.source.label} + Forex Factory forecast/previous` };
      continue;
    }
    out.push(f);
  }
  return out.sort((a, b) => a.time - b.time);
}

function sameRelease(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase();
  const A = norm(a);
  const B = norm(b);
  const keys: [RegExp, RegExp][] = [
    [/consumer price index|cpi/, /\bcpi\b/],
    [/non-farm|employment situation/, /non-farm employment/],
    [/fomc rate decision/, /federal funds rate/],
    [/fomc press conference/, /fomc press conference/],
    [/pce/, /core pce price index/],
    [/gdp/, /gdp/],
  ];
  return keys.some(([ka, kb]) => (ka.test(A) && kb.test(B)) || (ka.test(B) && kb.test(A)));
}

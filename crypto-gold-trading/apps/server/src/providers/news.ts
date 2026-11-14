/**
 * News aggregation from publisher RSS feeds (syndication feeds are published for exactly
 * this purpose). Each item keeps its publisher, timestamp and link.
 */
import { XMLParser } from "fast-xml-parser";
import { hashString } from "@terminal/core";
import { fetchText } from "../lib/http";
import { logger } from "../lib/logger";

const log = logger("news");

export type NewsTopic = "crypto" | "gold" | "macro";
/** What the news endpoint can be filtered by: a feed topic, or headlines the keyword rules tag as silver. */
export type NewsFilter = NewsTopic | "silver" | "all";

export interface NewsItem {
  id: string;
  title: string;
  link: string;
  publishedAt: number;
  publisher: string;
  topics: NewsTopic[];
  summary: string | null;
  /** Rule-based relevance tags (keyword rules on the title and summary). */
  relevance: ("gold" | "silver" | "btc" | "eth" | "crypto" | "fed" | "usd" | "geopolitics")[];
}

interface FeedDef {
  url: string;
  publisher: string;
  topics: NewsTopic[];
}

export const FEEDS: FeedDef[] = [
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", publisher: "CoinDesk", topics: ["crypto"] },
  { url: "https://cointelegraph.com/rss", publisher: "Cointelegraph", topics: ["crypto"] },
  { url: "https://www.theblock.co/rss.xml", publisher: "The Block", topics: ["crypto"] },
  { url: "https://decrypt.co/feed", publisher: "Decrypt", topics: ["crypto"] },
  { url: "https://www.fxstreet.com/rss/news", publisher: "FXStreet", topics: ["gold", "macro"] },
  { url: "https://www.fxempire.com/api/v1/en/articles/rss/news", publisher: "FXEmpire", topics: ["gold", "macro"] },
  { url: "https://www.mining.com/feed/", publisher: "MINING.com", topics: ["gold"] },
  { url: "https://www.gold.org/rss.xml", publisher: "World Gold Council", topics: ["gold"] },
  { url: "https://www.federalreserve.gov/feeds/press_all.xml", publisher: "Federal Reserve", topics: ["macro"] },
];

const parser = new XMLParser({ ignoreAttributes: false, cdataPropName: "__cdata", parseTagValue: false });

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.__cdata === "string") return o.__cdata;
    if (typeof o["#text"] === "string") return o["#text"] as string;
    if (typeof o["@_href"] === "string") return o["@_href"] as string;
  }
  return String(v);
}

function strip(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function tagNews(title: string, summary: string): NewsItem["relevance"] {
  const s = `${title} ${summary}`.toLowerCase();
  const out: NewsItem["relevance"] = [];
  if (/\bgold\b|xau|bullion|precious metal/.test(s)) out.push("gold");
  // "silver" as a word (not Silvergate, not a surname prefix), the XAG code, or the metals as a group.
  if (/\bsilver\b|\bxag|precious metal/.test(s)) out.push("silver");
  if (/bitcoin|\bbtc\b/.test(s)) out.push("btc");
  if (/ethereum|\beth\b/.test(s)) out.push("eth");
  if (/crypto|altcoin|stablecoin|defi|solana|xrp|binance|coinbase/.test(s) || out.includes("btc") || out.includes("eth")) out.push("crypto");
  if (/\bfed\b|fomc|powell|federal reserve|rate cut|rate hike|interest rate|treasury yield/.test(s)) out.push("fed");
  if (/dollar|dxy|greenback/.test(s)) out.push("usd");
  if (/war|sanction|geopolit|missile|ceasefire|tariff|conflict|nato|election/.test(s)) out.push("geopolitics");
  return out;
}

export function parseFeed(xml: string, def: FeedDef): NewsItem[] {
  const doc = parser.parse(xml);
  const items: Record<string, unknown>[] = doc?.rss?.channel?.item ? (Array.isArray(doc.rss.channel.item) ? doc.rss.channel.item : [doc.rss.channel.item]) : doc?.feed?.entry ? (Array.isArray(doc.feed.entry) ? doc.feed.entry : [doc.feed.entry]) : [];
  const out: NewsItem[] = [];
  for (const it of items) {
    const title = strip(text(it.title));
    const linkRaw = it.link;
    const link = Array.isArray(linkRaw) ? text(linkRaw[0]) : text(linkRaw);
    const dateRaw = text(it.pubDate ?? it.published ?? it.updated ?? it["dc:date"]);
    const publishedAt = Date.parse(dateRaw);
    if (!title || !link || !Number.isFinite(publishedAt)) continue;
    const summary = strip(text(it.description ?? it.summary ?? it["content:encoded"] ?? "")).slice(0, 280) || null;
    out.push({ id: `n_${hashString(link)}`, title, link, publishedAt, publisher: def.publisher, topics: def.topics, summary, relevance: tagNews(title, summary ?? "") });
  }
  return out;
}

export async function fetchAllNews(): Promise<{ items: NewsItem[]; failed: string[] }> {
  const results = await Promise.allSettled(FEEDS.map(async (f) => parseFeed(await fetchText(f.url, { timeoutMs: 12_000, retries: 1 }), f)));
  const items: NewsItem[] = [];
  const failed: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else {
      failed.push(FEEDS[i].publisher);
      log.warn(`feed failed: ${FEEDS[i].publisher}`, r.reason);
    }
  });
  const seen = new Set<string>();
  const dedup = items.filter((i) => (seen.has(i.link) ? false : (seen.add(i.link), true)));
  dedup.sort((a, b) => b.publishedAt - a.publishedAt);
  return { items: dedup.slice(0, 200), failed };
}

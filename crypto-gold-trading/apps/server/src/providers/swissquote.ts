/**
 * Swissquote public best-bid/offer feed (keyless). Live spot quotes for XAU/USD and the
 * six FX constituents of the US Dollar Index.
 */
import { fetchJson } from "../lib/http";

export interface SqQuote {
  instrument: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  ts: number; // epoch ms of the quote
}

interface SqPayload {
  spreadProfilePrices: { spreadProfile: string; bid: number; ask: number }[];
  ts: number;
}

export async function getSwissquoteQuote(instrument: string): Promise<SqQuote> {
  const url = `https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${instrument}`;
  const data = await fetchJson<SqPayload[]>(url, { timeoutMs: 10_000, retries: 1 });
  const first = data?.[0];
  if (!first) throw new Error(`Swissquote: no quote for ${instrument}`);
  const prime = first.spreadProfilePrices.find((p) => p.spreadProfile.toLowerCase() === "prime") ?? first.spreadProfilePrices[0];
  if (!prime || !(prime.bid > 0) || !(prime.ask > 0)) throw new Error(`Swissquote: malformed quote for ${instrument}`);
  return { instrument, bid: prime.bid, ask: prime.ask, mid: (prime.bid + prime.ask) / 2, spread: prime.ask - prime.bid, ts: first.ts };
}

/** ICE US Dollar Index formula on live constituent rates. */
export function dxyFromRates(r: { EURUSD: number; USDJPY: number; GBPUSD: number; USDCAD: number; USDSEK: number; USDCHF: number }): number {
  return 50.14348112 * Math.pow(r.EURUSD, -0.576) * Math.pow(r.USDJPY, 0.136) * Math.pow(r.GBPUSD, -0.119) * Math.pow(r.USDCAD, 0.091) * Math.pow(r.USDSEK, 0.042) * Math.pow(r.USDCHF, 0.036);
}

export async function getLiveDxyFromSwissquote(): Promise<{ value: number; ts: number; components: Record<string, number> }> {
  const pairs = ["EUR/USD", "USD/JPY", "GBP/USD", "USD/CAD", "USD/SEK", "USD/CHF"];
  const quotes = await Promise.all(pairs.map((p) => getSwissquoteQuote(p)));
  const r = { EURUSD: quotes[0].mid, USDJPY: quotes[1].mid, GBPUSD: quotes[2].mid, USDCAD: quotes[3].mid, USDSEK: quotes[4].mid, USDCHF: quotes[5].mid };
  return { value: dxyFromRates(r), ts: Math.min(...quotes.map((q) => q.ts)), components: r };
}

export async function getGoldApiPrice(): Promise<{ price: number; ts: number }> {
  const d = await fetchJson<{ price: number; updatedAt: string }>("https://api.gold-api.com/price/XAU", { timeoutMs: 10_000, retries: 1 });
  if (!(d.price > 0)) throw new Error("gold-api.com: no price");
  return { price: d.price, ts: Date.parse(d.updatedAt) || Date.now() };
}

/** Spot gold / FX trade from Sunday ~22:00 UTC to Friday ~22:00 UTC. */
export function isSpotMarketOpen(now: number): boolean {
  const d = new Date(now);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  if (day === 6) return false;
  if (day === 5 && hour >= 22) return false;
  if (day === 0 && hour < 22) return false;
  return true;
}

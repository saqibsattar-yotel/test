/**
 * Macro data for the gold workspace.
 *  - US Treasury yields: home.treasury.gov XML feeds (keyless, official, daily).
 *  - Real yields: Treasury real-yield-curve feed (TIPS), keyless.
 *  - Dollar index: FRED broad dollar index (key) or a SYNTHETIC DXY computed from ECB
 *    reference rates (Frankfurter) using the published ICE DXY weights.
 *  - FRED (key): DGS10, DGS2, DFII10, DTWEXBGS.
 */
import type { DataSource } from "@terminal/core";
import { XMLParser } from "fast-xml-parser";
import { config } from "../config";
import { fetchJson, fetchText } from "../lib/http";

export interface MacroSeries {
  id: string;
  label: string;
  unit: string;
  points: { date: string; value: number }[]; // oldest -> newest
  latest: number;
  change1d: number | null;
  change20d: number | null;
  source: DataSource;
}

function monthKeys(count: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false });

async function treasuryFeed(kind: "daily_treasury_yield_curve" | "daily_treasury_real_yield_curve", months = 4): Promise<Record<string, Record<string, number>>> {
  const byDate: Record<string, Record<string, number>> = {};
  for (const m of monthKeys(months)) {
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=${kind}&field_tdr_date_value_month=${m}`;
    const xml = await fetchText(url, { timeoutMs: 20_000 });
    const doc = parser.parse(xml);
    const entries = doc?.feed?.entry;
    const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
    for (const e of list) {
      const props = e?.content?.properties;
      if (!props) continue;
      const dateRaw = props.NEW_DATE?.["#text"] ?? props.NEW_DATE;
      if (!dateRaw) continue;
      const date = String(dateRaw).slice(0, 10);
      const row: Record<string, number> = {};
      for (const [k, v] of Object.entries(props)) {
        const val = typeof v === "object" && v !== null ? (v as Record<string, string>)["#text"] : (v as string);
        const num = parseFloat(String(val));
        if (Number.isFinite(num)) row[k] = num;
      }
      byDate[date] = row;
    }
  }
  return byDate;
}

function toSeries(id: string, label: string, unit: string, byDate: Record<string, Record<string, number>>, field: string, source: DataSource): MacroSeries {
  const points = Object.entries(byDate)
    .filter(([, r]) => Number.isFinite(r[field]))
    .map(([date, r]) => ({ date, value: r[field] }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = points[points.length - 1]?.value ?? NaN;
  const prev = points[points.length - 2]?.value;
  const p20 = points[points.length - 21]?.value;
  return { id, label, unit, points, latest, change1d: prev !== undefined ? latest - prev : null, change20d: p20 !== undefined ? latest - p20 : null, source: { ...source, asOf: points.length ? Date.parse(`${points[points.length - 1].date}T21:00:00Z`) : Date.now() } };
}

export async function getTreasuryYields(): Promise<{ dgs10: MacroSeries; dgs2: MacroSeries; curve2s10s: MacroSeries }> {
  const byDate = await treasuryFeed("daily_treasury_yield_curve");
  const src: DataSource = { provider: "treasury.gov", label: "US Treasury daily par yield curve", fetchedAt: Date.now(), asOf: Date.now(), quality: "live", note: "Official end-of-day constant-maturity yields; published after the US close (T+0 evening / T+1).", url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates" };
  const dgs10 = toSeries("DGS10", "US 10-year Treasury yield", "%", byDate, "BC_10YEAR", src);
  const dgs2 = toSeries("DGS2", "US 2-year Treasury yield", "%", byDate, "BC_2YEAR", src);
  const spread: Record<string, Record<string, number>> = {};
  for (const [d, r] of Object.entries(byDate)) if (Number.isFinite(r.BC_10YEAR) && Number.isFinite(r.BC_2YEAR)) spread[d] = { S: r.BC_10YEAR - r.BC_2YEAR };
  const curve2s10s = toSeries("T10Y2Y", "2s10s curve", "pp", spread, "S", src);
  return { dgs10, dgs2, curve2s10s };
}

export async function getRealYields(): Promise<MacroSeries> {
  const byDate = await treasuryFeed("daily_treasury_real_yield_curve");
  const src: DataSource = { provider: "treasury.gov", label: "US Treasury daily real (TIPS) yield curve", fetchedAt: Date.now(), asOf: Date.now(), quality: "live", note: "10-year real yield from the Treasury real yield curve (TIPS). Official, end-of-day.", url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates" };
  return toSeries("DFII10", "US 10-year real yield (TIPS)", "%", byDate, "TC_10YEAR", src);
}

/** ICE U.S. Dollar Index formula and weights (public domain methodology). */
export function syntheticDxy(r: { EUR: number; JPY: number; GBP: number; CAD: number; SEK: number; CHF: number }): number {
  // Rates are USD-based (1 USD = r[X] units of X). EURUSD = 1/EUR, GBPUSD = 1/GBP.
  const eurusd = 1 / r.EUR;
  const gbpusd = 1 / r.GBP;
  return 50.14348112 * Math.pow(eurusd, -0.576) * Math.pow(r.JPY, 0.136) * Math.pow(gbpusd, -0.119) * Math.pow(r.CAD, 0.091) * Math.pow(r.SEK, 0.042) * Math.pow(r.CHF, 0.036);
}

export async function getSyntheticDxy(days = 400): Promise<MacroSeries> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const url = `https://api.frankfurter.dev/v1/${fmt(start)}..${fmt(end)}?base=USD&symbols=EUR,JPY,GBP,CAD,SEK,CHF`;
  const res = await fetchJson<{ rates: Record<string, { EUR: number; JPY: number; GBP: number; CAD: number; SEK: number; CHF: number }> }>(url, { timeoutMs: 20_000 });
  const points = Object.entries(res.rates)
    .filter(([, r]) => ["EUR", "JPY", "GBP", "CAD", "SEK", "CHF"].every((k) => Number.isFinite((r as Record<string, number>)[k])))
    .map(([date, r]) => ({ date, value: syntheticDxy(r) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = points[points.length - 1]?.value ?? NaN;
  const prev = points[points.length - 2]?.value;
  const p20 = points[points.length - 21]?.value;
  return {
    id: "DXY_SYNTH",
    label: "Synthetic US Dollar Index (ECB reference rates)",
    unit: "index",
    points,
    latest,
    change1d: prev !== undefined ? latest - prev : null,
    change20d: p20 !== undefined ? latest - p20 : null,
    source: { provider: "frankfurter/ecb", label: "SYNTHETIC DXY — ICE weights applied to ECB daily reference rates via Frankfurter", fetchedAt: Date.now(), asOf: points.length ? Date.parse(`${points[points.length - 1].date}T15:00:00Z`) : Date.now(), quality: "proxy", proxy: true, note: "Not the ICE DXY futures/index print. ECB reference rates are set once per business day (~16:00 CET); the level tracks DXY closely but is not identical.", url },
  };
}

export async function getFredSeries(id: string, label: string, unit: string, limit = 400): Promise<MacroSeries> {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&file_type=json&sort_order=desc&limit=${limit}&api_key=${config.FRED_API_KEY}`;
  const res = await fetchJson<{ observations: { date: string; value: string }[] }>(url);
  const points = res.observations
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
    .filter((p) => Number.isFinite(p.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = points[points.length - 1]?.value ?? NaN;
  const prev = points[points.length - 2]?.value;
  const p20 = points[points.length - 21]?.value;
  return { id, label, unit, points, latest, change1d: prev !== undefined ? latest - prev : null, change20d: p20 !== undefined ? latest - p20 : null, source: { provider: "fred", label: `FRED ${id}`, fetchedAt: Date.now(), asOf: points.length ? Date.parse(`${points[points.length - 1].date}T21:00:00Z`) : Date.now(), quality: "live", note: "Federal Reserve Bank of St. Louis FRED; daily series with a one-business-day publication lag.", url: `https://fred.stlouisfed.org/series/${id}` } };
}

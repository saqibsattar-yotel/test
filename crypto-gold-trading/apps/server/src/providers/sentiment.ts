import type { DataSource } from "@terminal/core";
import { fetchJson } from "../lib/http";

export interface FearGreed {
  value: number;
  classification: string;
  timestamp: number;
  history: { time: number; value: number }[];
  source: DataSource;
}

export async function getFearGreed(): Promise<FearGreed> {
  const url = "https://api.alternative.me/fng/?limit=30";
  const res = await fetchJson<{ data: { value: string; value_classification: string; timestamp: string }[] }>(url);
  const data = res.data ?? [];
  if (!data.length) throw new Error("Fear & Greed: empty payload");
  const latest = data[0];
  return {
    value: parseInt(latest.value, 10),
    classification: latest.value_classification,
    timestamp: parseInt(latest.timestamp, 10) * 1000,
    history: data.map((d) => ({ time: parseInt(d.timestamp, 10) * 1000, value: parseInt(d.value, 10) })).reverse(),
    source: { provider: "alternative.me", label: "Crypto Fear & Greed Index (alternative.me)", fetchedAt: Date.now(), asOf: parseInt(latest.timestamp, 10) * 1000, quality: "live", url, note: "Composite sentiment index updated daily." },
  };
}

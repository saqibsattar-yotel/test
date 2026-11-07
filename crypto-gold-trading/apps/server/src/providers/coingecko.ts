import type { DataSource } from "@terminal/core";
import { fetchJson } from "../lib/http";

const BASE = "https://api.coingecko.com/api/v3";

export interface GlobalMarket {
  totalMarketCapUsd: number;
  totalVolume24hUsd: number;
  btcDominancePct: number;
  ethDominancePct: number;
  marketCapChange24hPct: number;
  activeCryptocurrencies: number;
  source: DataSource;
}

export interface CoinMarket {
  id: string;
  symbol: string;
  name: string;
  priceUsd: number;
  marketCapUsd: number;
  volume24hUsd: number;
  change24hPct: number | null;
  change7dPct: number | null;
  rank: number;
}

export async function getGlobal(): Promise<GlobalMarket> {
  const url = `${BASE}/global`;
  const res = await fetchJson<{ data: { total_market_cap: Record<string, number>; total_volume: Record<string, number>; market_cap_percentage: Record<string, number>; market_cap_change_percentage_24h_usd: number; active_cryptocurrencies: number; updated_at: number } }>(url);
  const d = res.data;
  return {
    totalMarketCapUsd: d.total_market_cap.usd,
    totalVolume24hUsd: d.total_volume.usd,
    btcDominancePct: d.market_cap_percentage.btc,
    ethDominancePct: d.market_cap_percentage.eth,
    marketCapChange24hPct: d.market_cap_change_percentage_24h_usd,
    activeCryptocurrencies: d.active_cryptocurrencies,
    source: { provider: "coingecko", label: "CoinGecko /global", fetchedAt: Date.now(), asOf: d.updated_at * 1000, quality: "live", url, note: "Free tier; refreshed every few minutes." },
  };
}

export async function getTopCoins(perPage = 30): Promise<{ coins: CoinMarket[]; source: DataSource }> {
  const url = `${BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=1&price_change_percentage=24h,7d`;
  const raw = await fetchJson<Record<string, unknown>[]>(url);
  const coins = raw.map((c) => ({
    id: String(c.id),
    symbol: String(c.symbol).toUpperCase(),
    name: String(c.name),
    priceUsd: Number(c.current_price),
    marketCapUsd: Number(c.market_cap),
    volume24hUsd: Number(c.total_volume),
    change24hPct: c.price_change_percentage_24h_in_currency !== null && c.price_change_percentage_24h_in_currency !== undefined ? Number(c.price_change_percentage_24h_in_currency) : null,
    change7dPct: c.price_change_percentage_7d_in_currency !== null && c.price_change_percentage_7d_in_currency !== undefined ? Number(c.price_change_percentage_7d_in_currency) : null,
    rank: Number(c.market_cap_rank),
  }));
  return { coins, source: { provider: "coingecko", label: "CoinGecko /coins/markets", fetchedAt: Date.now(), asOf: Date.now(), quality: "live", url } };
}

export const STABLE_OR_WRAPPED = new Set(["USDT", "USDC", "DAI", "FDUSD", "USDE", "USDS", "PYUSD", "TUSD", "FRAX", "BUSD", "USD1", "WBTC", "WSTETH", "STETH", "WETH", "CBBTC", "WEETH", "RETH", "WBETH", "SUSDS", "USDTB", "BSC-USD", "LEO", "FIGR_HELOC", "BUIDL"]);

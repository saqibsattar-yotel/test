import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { resolveAsset, type AssetClass, type AssetMeta } from "@terminal/core";
import { api } from "./api";

export interface AssetInfo {
  id: string;
  symbol: string;
  name: string;
  base: string;
  assetClass: AssetClass;
  rank: number | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
  binanceSymbol: string | null;
  pricePrecision: number;
  core: boolean;
}

export interface AssetsResponse {
  assets: AssetInfo[];
  total: number;
  loaded: boolean;
  loadedAt: number;
  note: string;
}

/** The live asset universe (Binance USDT spot pairs + spot gold and silver), cached for an hour. */
export const useAssets = () => useQuery({ queryKey: ["assets"], queryFn: () => api.get<AssetsResponse>("/api/assets?limit=1000"), staleTime: 60 * 60_000, refetchInterval: 60 * 60_000 });

export function useAssetIndex(): Map<string, AssetInfo> {
  const q = useAssets();
  return useMemo(() => new Map((q.data?.assets ?? []).map((a) => [a.id, a])), [q.data]);
}

/** Returns a resolver `(id) => AssetMeta` backed by the registry, falling back to derived metadata. */
export function useAssetLabel(): (id: string) => AssetMeta {
  const index = useAssetIndex();
  return useCallback(
    (id: string) => {
      const info = index.get(id);
      return resolveAsset(id, info ? { name: info.name, pricePrecision: info.pricePrecision, price: info.priceUsd ?? undefined } : {});
    },
    [index],
  );
}

export function searchAssets(list: AssetInfo[], query: string, opts: { cryptoOnly?: boolean; exclude?: string[]; limit?: number } = {}): AssetInfo[] {
  const t = query.trim().toUpperCase();
  const excluded = new Set(opts.exclude ?? []);
  const pool = list.filter((a) => !excluded.has(a.id) && (!opts.cryptoOnly || a.assetClass === "crypto"));
  const rankOf = (a: AssetInfo) => (a.core ? -1 : (a.rank ?? 1e9));
  if (!t) return [...pool].sort((a, b) => rankOf(a) - rankOf(b)).slice(0, opts.limit ?? 10);
  const scored = pool
    .map((a) => {
      const base = a.base.toUpperCase();
      const name = a.name.toUpperCase();
      const score = base === t ? 0 : base.startsWith(t) ? 1 : name.startsWith(t) ? 2 : base.includes(t) ? 3 : name.includes(t) ? 4 : -1;
      return { a, score };
    })
    .filter((x) => x.score >= 0)
    .sort((x, y) => x.score - y.score || rankOf(x.a) - rankOf(y.a));
  return scored.slice(0, opts.limit ?? 12).map((x) => x.a);
}

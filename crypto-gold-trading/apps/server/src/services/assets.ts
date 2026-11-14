/**
 * Dynamic asset registry: every Binance USDT spot pair that is currently trading, enriched
 * with CoinGecko names, ranks and market caps, plus the curated core set, spot gold and spot silver.
 * Refreshed every 6 hours; routes validate ids against it and the UI searches it.
 */
import { ASSETS, METALS, assetBase, isAssetId, isCoreAsset, isMetalAsset, precisionForPrice, resolveAsset, type AssetClass, type AssetMeta } from "@terminal/core";
import { fetchJson } from "../lib/http";
import { logger } from "../lib/logger";

const log = logger("assets");

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

export interface ExchangeSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  tickSize?: number;
}
export interface CgCoin {
  symbol: string;
  name: string;
  rank: number | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
}

/** Fiat, stablecoins, wrapped/leveraged products that are not tradable "coins" for analysis. */
const EXCLUDED_BASES = new Set(["USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "USD1", "EUR", "EURI", "GBP", "TRY", "BRL", "JPY", "AUD", "ZAR", "NGN", "UAH", "RUB", "PLN", "RON", "ARS", "BIDR", "IDRT", "VAI", "USDE", "USDS", "AEUR", "XUSD", "USTC", "USDT", "BFUSD", "RLUSD", "PYUSD"]);
const LEVERAGED_RE = /(UP|DOWN|BULL|BEAR)$/;

export function buildRegistry(exchangeSymbols: ExchangeSymbol[], coins: CgCoin[]): Map<string, AssetInfo> {
  const byId = new Map<string, AssetInfo>();
  const cgBySymbol = new Map<string, CgCoin>();
  for (const c of coins) {
    const key = c.symbol.toUpperCase();
    const prev = cgBySymbol.get(key);
    if (!prev || (c.rank ?? Infinity) < (prev.rank ?? Infinity)) cgBySymbol.set(key, c);
  }
  // Core assets first (hand-tuned metadata).
  for (const meta of Object.values(ASSETS)) {
    if (isMetalAsset(meta.id)) {
      // Spot metals are not exchange coins: no Binance symbol, and never a look-alike ticker's CoinGecko data.
      const m = METALS[meta.id];
      byId.set(meta.id, { id: meta.id, symbol: meta.symbol, name: `${m.title} — spot ${m.pair}`, base: meta.base, assetClass: meta.assetClass, rank: null, marketCapUsd: null, priceUsd: null, binanceSymbol: null, pricePrecision: meta.pricePrecision, core: true });
      continue;
    }
    const cg = cgBySymbol.get(meta.base);
    byId.set(meta.id, { id: meta.id, symbol: meta.symbol, name: meta.name, base: meta.base, assetClass: meta.assetClass, rank: cg?.rank ?? null, marketCapUsd: cg?.marketCapUsd ?? null, priceUsd: cg?.priceUsd ?? null, binanceSymbol: `${meta.base}USDT`, pricePrecision: meta.pricePrecision, core: true });
  }
  for (const s of exchangeSymbols) {
    if (s.quoteAsset !== "USDT" || s.status !== "TRADING") continue;
    const base = s.baseAsset.toUpperCase();
    if (EXCLUDED_BASES.has(base) || LEVERAGED_RE.test(base) && base.length > 4) continue;
    const id = `${base}USD`;
    if (!isAssetId(id) || byId.has(id)) continue;
    const cg = cgBySymbol.get(base);
    const price = cg?.priceUsd ?? null;
    const tickDecimals = s.tickSize ? Math.max(0, Math.round(-Math.log10(s.tickSize))) : 4;
    byId.set(id, { id, symbol: `${base}/USD`, name: base === "PAXG" ? "PAX Gold — tokenised gold (not spot)" : base === "XAUT" ? "Tether Gold — tokenised gold (not spot)" : (cg?.name ?? base), base, assetClass: "crypto", rank: cg?.rank ?? null, marketCapUsd: cg?.marketCapUsd ?? null, priceUsd: price, binanceSymbol: s.symbol, pricePrecision: price ? Math.min(precisionForPrice(price), Math.max(tickDecimals, 2)) : tickDecimals, core: false });
  }
  return byId;
}

class AssetRegistry {
  private byId = new Map<string, AssetInfo>();
  loaded = false;
  loadedAt = 0;
  private timer: NodeJS.Timeout | null = null;

  async load(): Promise<void> {
    try {
      const [ex, cg] = await Promise.all([
        fetchJson<{ symbols: { symbol: string; baseAsset: string; quoteAsset: string; status: string; filters: { filterType: string; tickSize?: string }[] }[] }>("https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT", { timeoutMs: 20_000 }),
        fetchJson<Record<string, unknown>[]>("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1", { timeoutMs: 20_000 }).catch((err) => {
          log.warn(`CoinGecko enrichment failed: ${(err as Error).message}`);
          return [] as Record<string, unknown>[];
        }),
      ]);
      const symbols: ExchangeSymbol[] = ex.symbols.map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset, status: s.status, tickSize: parseFloat(s.filters.find((f) => f.filterType === "PRICE_FILTER")?.tickSize ?? "") || undefined }));
      const coins: CgCoin[] = cg.map((c) => ({ symbol: String(c.symbol), name: String(c.name), rank: typeof c.market_cap_rank === "number" ? c.market_cap_rank : null, marketCapUsd: typeof c.market_cap === "number" ? c.market_cap : null, priceUsd: typeof c.current_price === "number" ? c.current_price : null }));
      this.byId = buildRegistry(symbols, coins);
      this.loaded = true;
      this.loadedAt = Date.now();
      log.info(`asset registry loaded: ${this.byId.size} assets (${coins.length} enriched from CoinGecko)`);
    } catch (err) {
      log.warn(`asset registry load failed: ${(err as Error).message}; falling back to core assets`);
      if (!this.loaded) this.byId = buildRegistry([], []);
    }
  }

  start() {
    void this.load();
    this.timer = setInterval(() => void this.load(), 6 * 3_600_000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Known in the live registry; before the registry loads, any well-formed id passes (providers will reject unknowns). */
  isSupported(id: string): boolean {
    if (!isAssetId(id)) return false;
    if (isCoreAsset(id)) return true;
    return this.loaded ? this.byId.has(id) : true;
  }
  get(id: string): AssetInfo | undefined {
    return this.byId.get(id);
  }
  meta(id: string, price?: number): AssetMeta {
    const info = this.byId.get(id);
    return resolveAsset(id, { name: info?.name, price: price ?? info?.priceUsd ?? undefined, pricePrecision: info?.pricePrecision });
  }
  list(limit = 600): AssetInfo[] {
    return [...this.byId.values()].sort(rankSort).slice(0, limit);
  }
  search(q: string, limit = 20): AssetInfo[] {
    const t = q.trim().toUpperCase();
    if (!t) return this.list(limit);
    const scored = [...this.byId.values()]
      .map((a) => {
        const base = a.base.toUpperCase();
        const name = a.name.toUpperCase();
        let score = -1;
        if (base === t) score = 0;
        else if (base.startsWith(t)) score = 1;
        else if (name.startsWith(t)) score = 2;
        else if (base.includes(t)) score = 3;
        else if (name.includes(t)) score = 4;
        return { a, score };
      })
      .filter((x) => x.score >= 0)
      .sort((x, y) => x.score - y.score || rankSort(x.a, y.a));
    return scored.slice(0, limit).map((x) => x.a);
  }
  topBinanceSymbols(n: number): string[] {
    return this.list(n).map((a) => a.binanceSymbol).filter((s): s is string => !!s && s !== "PAXGUSDT");
  }
  size() {
    return this.byId.size;
  }
}

function rankSort(a: AssetInfo, b: AssetInfo): number {
  if (a.core !== b.core) return a.core ? -1 : 1;
  const ra = a.rank ?? Infinity;
  const rb = b.rank ?? Infinity;
  if (ra !== rb) return ra - rb;
  return a.base.localeCompare(b.base);
}

export const assets = new AssetRegistry();
export { assetBase };

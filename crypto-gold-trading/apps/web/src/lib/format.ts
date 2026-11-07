import { resolveAsset, type AssetId, type DataSource, type SetupStatus } from "@terminal/core";
import { formatInZone, humanDuration } from "@terminal/core";

export function precisionFor(assetId?: AssetId | null, price?: number): number {
  if (assetId) return resolveAsset(assetId, { price }).pricePrecision;
  if (price === undefined || !Number.isFinite(price)) return 2;
  if (Math.abs(price) >= 1000) return 1;
  if (Math.abs(price) >= 10) return 2;
  if (Math.abs(price) >= 1) return 3;
  return 5;
}

export function fmtPrice(v: number | null | undefined, assetId?: AssetId | null, opts: { compact?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const p = precisionFor(assetId, v);
  if (opts.compact && Math.abs(v) >= 100000) return fmtCompact(v);
  return v.toLocaleString("en-US", { minimumFractionDigits: Math.min(p, 2), maximumFractionDigits: p });
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtCompact(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(digits)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(digits)}K`;
  return `${sign}${abs.toFixed(digits)}`;
}

export function fmtMoney(v: number | null | undefined, currency = "USD", digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (Math.abs(v) < 1e-9) v = 0;
  try {
    return v.toLocaleString("en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
  } catch {
    return `${v.toFixed(digits)} ${currency}`;
  }
}

export function fmtPct(v: number | null | undefined, digits = 2, signed = true): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const s = signed && v > 0 ? "+" : "";
  return `${s}${v.toFixed(digits)}%`;
}

export function fmtSigned(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${fmtNum(v, digits)}`;
}

export function fmtR(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}R`;
}

export function fmtTime(epoch: number | null | undefined, zone: string, withSeconds = false): string {
  if (!epoch) return "—";
  return formatInZone(epoch, zone, { hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}) });
}

export function fmtDate(epoch: number | null | undefined, zone: string): string {
  if (!epoch) return "—";
  return formatInZone(epoch, zone, { day: "2-digit", month: "short", year: "numeric" });
}

export function fmtDateTime(epoch: number | null | undefined, zone: string): string {
  if (!epoch) return "—";
  return formatInZone(epoch, zone, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function fmtWeekday(epoch: number, zone: string): string {
  return formatInZone(epoch, zone, { weekday: "short" });
}

export function fmtAge(epoch: number | null | undefined, now = Date.now()): string {
  if (!epoch) return "—";
  const diff = now - epoch;
  if (diff < 0) return `in ${humanDuration(-diff)}`;
  if (diff < 10_000) return "just now";
  return `${humanDuration(diff)} ago`;
}

export function fmtUntil(epoch: number, now = Date.now()): string {
  const diff = epoch - now;
  if (diff <= 0) return "now";
  return `in ${humanDuration(diff)}`;
}

export function toneForChange(v: number | null | undefined): "bull" | "bear" | "neutral" {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return "neutral";
  return v > 0 ? "bull" : "bear";
}

export function statusTone(status: SetupStatus): "bull" | "bear" | "neutral" | "warning" | "muted" {
  switch (status) {
    case "STRONG LONG":
    case "LONG":
      return "bull";
    case "STRONG SHORT":
    case "SHORT":
      return "bear";
    case "WAIT FOR CONFIRMATION":
      return "warning";
    case "NEUTRAL":
      return "neutral";
    default:
      return "muted";
  }
}

export function qualityLabel(src: DataSource): { label: string; tone: "bull" | "warning" | "bear" | "muted" | "gold" } {
  switch (src.quality) {
    case "live":
      return { label: "Live", tone: "bull" };
    case "delayed":
      return { label: "Delayed", tone: "warning" };
    case "stale":
      return { label: "Stale", tone: "warning" };
    case "proxy":
      return { label: "Proxy", tone: "gold" };
    case "demo":
      return { label: "DEMO", tone: "bear" };
    case "closed":
      return { label: "Market closed", tone: "muted" };
    default:
      return { label: "Unavailable", tone: "muted" };
  }
}

export function assetLabel(assetId: AssetId): string {
  return resolveAsset(assetId).symbol;
}

export function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function setupTypeLabel(t: string | null | undefined): string {
  if (!t) return "—";
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

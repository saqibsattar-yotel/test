/**
 * Gold and silver in the UI: where each lives, what it is called and which colour names it.
 * Everything that treats "the metals" differently from coins goes through here, so the two
 * are always treated alike.
 */
import { METALS, isMetalAsset, isMetalClass, metalInfo, resolveAsset, type AssetId, type Metal, type MetalInfo } from "@terminal/core";

/** Text colour class that names a metal ("text-gold", "text-silver"). */
export const METAL_TEXT: Record<Metal, string> = { gold: "text-gold", silver: "text-silver" };
/** Tinted background plus matching text, for avatars and highlighted tiles. */
export const METAL_SOFT: Record<Metal, string> = { gold: "bg-gold-soft text-gold", silver: "bg-silver-soft text-silver" };
/** Tinted background only. */
export const METAL_SOFT_BG: Record<Metal, string> = { gold: "bg-gold-soft", silver: "bg-silver-soft" };
/** Chemical symbol, for the small square glyph that stands for an asset. */
export const METAL_GLYPH: Record<Metal, string> = { gold: "Au", silver: "Ag" };
/** Selected-state border and background for a metal chip or toggle. */
export const METAL_SELECTED: Record<Metal, string> = { gold: "border-gold/50 bg-gold-soft", silver: "border-silver/50 bg-silver-soft" };
/** An active chip that names a metal. */
export const METAL_CHIP: Record<Metal, string> = { gold: "border-gold/40 bg-gold-soft text-gold", silver: "border-silver/40 bg-silver-soft text-silver" };

/** The metal an asset id stands for, or null for a coin. */
export function metalOf(assetId: AssetId | null | undefined): Metal | null {
  return assetId && isMetalAsset(assetId) ? METALS[assetId].metal : null;
}

/** The metal of an asset class ("gold" / "silver"), or null for crypto. */
export function metalOfClass(assetClass: string | null | undefined): Metal | null {
  return isMetalClass(assetClass) ? assetClass : null;
}

/** The workspace page of an asset: /gold, /silver, or the crypto workspace for every coin. */
export function workspacePath(assetId: AssetId): string {
  const metal = metalOf(assetId);
  return metal ? `/${metal}` : "/crypto";
}

/** Colour tone for a chip or badge that names an asset. */
export function assetTone(assetId: AssetId): "gold" | "silver" | "accent" {
  return metalOf(assetId) ?? "accent";
}

/** Text colour class for an asset's name: the metal's own colour, or `fallback` for coins. */
export function assetTextClass(assetId: AssetId, fallback = "text-ink-1"): string {
  const metal = metalOf(assetId);
  return metal ? METAL_TEXT[metal] : fallback;
}

/** Same, starting from an asset class (journal trades store the class). */
export function classTextClass(assetClass: string | null | undefined, fallback = "text-ink-1"): string {
  const metal = metalOfClass(assetClass);
  return metal ? METAL_TEXT[metal] : fallback;
}

/**
 * Where today's value sits among a set of past daily closes, in words: "the highest of them",
 * "the lowest of them", or "at or above 65% of them". `percentile` is the share of closes at or below today.
 */
export function rankAmongCloses(percentile: number, days: number): string {
  const atOrBelow = Math.round(percentile * days); // how many of the closes today is at or above
  if (atOrBelow >= days) return "the highest of them";
  if (atOrBelow <= 1) return "the lowest of them"; // at most today's own bar is not above it
  // Never "100%" (or "0%") for a value that is not the extreme: 251 of 252 is 99%, not 100%.
  return `at or above ${Math.min(99, Math.max(1, Math.round(percentile * 100)))}% of them`;
}

/** The unit a metal position is counted in on a broker platform, or the coin's ticker. */
export function quantityUnitFor(assetId: AssetId): string {
  return isMetalAsset(assetId) ? "lots" : resolveAsset(assetId).base;
}

export { METALS, isMetalAsset, metalInfo, type Metal, type MetalInfo };

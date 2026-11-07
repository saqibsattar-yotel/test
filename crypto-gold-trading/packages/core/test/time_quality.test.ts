import { describe, it, expect } from "vitest";
import { zonedParts, zoneOffsetMinutes, zonedTimeToUtc, formatInZone, startOfUtcWeek, validateCandles, assessQuoteAge, pricesDisagree, demoCandles, isValidTimeZone } from "../src";

describe("timezone utilities", () => {
  it("converts an instant to New York wall time across DST", () => {
    const summer = Date.UTC(2026, 6, 1, 12); // July: EDT (UTC-4)
    const winter = Date.UTC(2026, 0, 15, 12); // January: EST (UTC-5)
    expect(zonedParts(summer, "America/New_York").hour).toBe(8);
    expect(zonedParts(winter, "America/New_York").hour).toBe(7);
    expect(zoneOffsetMinutes(summer, "America/New_York")).toBe(-240);
    expect(zoneOffsetMinutes(winter, "America/New_York")).toBe(-300);
  });
  it("round-trips a wall-clock time in a zone back to the same instant", () => {
    const zone = "Europe/London";
    const instant = Date.UTC(2026, 10, 10, 13, 30); // CPI 08:30 ET = 13:30 UTC in November
    const p = zonedParts(instant, zone);
    expect(zonedTimeToUtc(p, zone)).toBe(instant);
    const ny = zonedTimeToUtc({ year: 2026, month: 11, day: 10, hour: 8, minute: 30 }, "America/New_York");
    expect(ny).toBe(instant);
  });
  it("handles Tokyo (no DST) and Kolkata (half-hour offset)", () => {
    const t = Date.UTC(2026, 2, 1, 0);
    expect(zoneOffsetMinutes(t, "Asia/Tokyo")).toBe(540);
    expect(zoneOffsetMinutes(t, "Asia/Kolkata")).toBe(330);
    expect(zonedParts(t, "Asia/Kolkata").hour).toBe(5);
    expect(zonedParts(t, "Asia/Kolkata").minute).toBe(30);
  });
  it("formats and validates zones", () => {
    expect(formatInZone(Date.UTC(2026, 10, 7, 15), "UTC", { hour: "2-digit", minute: "2-digit" })).toBe("15:00");
    expect(isValidTimeZone("Europe/Paris")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
  it("startOfUtcWeek returns the Monday", () => {
    const wed = Date.UTC(2026, 10, 4, 15);
    const mon = startOfUtcWeek(wed);
    expect(new Date(mon).getUTCDay()).toBe(1);
    expect(mon).toBe(Date.UTC(2026, 10, 2));
  });
});

describe("data quality", () => {
  const now = Date.UTC(2026, 10, 7, 12);
  it("accepts clean demo candles", () => {
    const c = demoCandles("BTCUSD", "1h", 200, now);
    const q = validateCandles(c, "1h", now);
    expect(q.ok).toBe(true);
    expect(q.stale).toBe(false);
  });
  it("flags stale, inconsistent, and non-monotonic data", () => {
    const c = demoCandles("BTCUSD", "1h", 200, now - 10 * 3600_000);
    const stale = validateCandles(c, "1h", now);
    expect(stale.stale).toBe(true);
    const bad = demoCandles("BTCUSD", "1h", 200, now);
    bad[50].high = bad[50].low - 1;
    bad[60].time = bad[59].time - 1;
    bad[70].close = NaN;
    const q = validateCandles(bad, "1h", now);
    expect(q.ok).toBe(false);
    expect(q.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["ohlc_inconsistent", "non_monotonic_time", "non_finite"]));
  });
  it("rejects empty and too-short series", () => {
    expect(validateCandles([], "1h", now).ok).toBe(false);
    expect(validateCandles(demoCandles("BTCUSD", "1h", 10, now), "1h", now).ok).toBe(false);
  });
  it("assesses quote age and cross-source disagreement", () => {
    expect(assessQuoteAge(now - 60_000, now, 5 * 60_000).stale).toBe(false);
    expect(assessQuoteAge(now - 10 * 60_000, now, 5 * 60_000).stale).toBe(true);
    expect(assessQuoteAge(NaN, now, 1000).ok).toBe(false);
    expect(pricesDisagree(100, 100.5)).toBe(false);
    expect(pricesDisagree(100, 103)).toBe(true);
  });
});

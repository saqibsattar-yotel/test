/**
 * Gold and silver are treated alike in the UI: each has its own page, colour and lot unit, and the
 * first-start notice names exactly the metals that are still downloading.
 */
import { describe, expect, it } from "vitest";
import { assetTextClass, assetTone, classTextClass, metalOf, quantityUnitFor, rankAmongCloses, workspacePath, METAL_GLYPH } from "../src/lib/metals";
import { describeGaps, describeUnavailable, describeWarmup } from "../src/lib/warmup";
import { ApiError, isUnavailableError, isWarmingError, type WarmupStatus } from "../src/lib/api";
import { NAV } from "../src/components/layout/nav";

describe("metals in the UI", () => {
  it("sends each asset to its own workspace", () => {
    expect(workspacePath("XAUUSD")).toBe("/gold");
    expect(workspacePath("XAGUSD")).toBe("/silver");
    expect(workspacePath("BTCUSD")).toBe("/crypto");
    expect(workspacePath("PAXGUSD")).toBe("/crypto"); // the token is a coin, not the metal
  });
  it("gives silver its own colour, glyph and lot unit, the same way as gold", () => {
    expect(metalOf("XAGUSD")).toBe("silver");
    expect(metalOf("ETHUSD")).toBeNull();
    expect(assetTone("XAUUSD")).toBe("gold");
    expect(assetTone("XAGUSD")).toBe("silver");
    expect(assetTone("SOLUSD")).toBe("accent");
    expect(assetTextClass("XAGUSD")).toBe("text-silver");
    expect(assetTextClass("XAUUSD")).toBe("text-gold");
    expect(assetTextClass("BTCUSD", "text-ink-2")).toBe("text-ink-2");
    expect(classTextClass("silver")).toBe("text-silver");
    expect(classTextClass("crypto")).toBe("text-ink-1");
    expect(METAL_GLYPH).toEqual({ gold: "Au", silver: "Ag" });
    expect(quantityUnitFor("XAGUSD")).toBe("lots");
    expect(quantityUnitFor("XAUUSD")).toBe("lots");
    expect(quantityUnitFor("ADAUSD")).toBe("ADA");
  });
  it("says where the gold/silver ratio sits in its year in plain words", () => {
    expect(rankAmongCloses(0.65, 252)).toBe("at or above 65% of them");
    expect(rankAmongCloses(251 / 252, 252)).toBe("at or above 99% of them"); // one close was higher: not "100%"
    expect(rankAmongCloses(2 / 252, 252)).toBe("at or above 1% of them"); // not "0%"
    expect(rankAmongCloses(1, 252)).toBe("the highest of them");
    expect(rankAmongCloses(1 / 252, 252)).toBe("the lowest of them");
    expect(rankAmongCloses(0, 252)).toBe("the lowest of them");
  });
  it("lists Silver Analysis right after Gold Analysis, with its own shortcut", () => {
    const gold = NAV.findIndex((n) => n.to === "/gold");
    expect(NAV[gold + 1]).toMatchObject({ to: "/silver", label: "Silver Analysis", short: "Silver", mobile: true });
    const keys = NAV.map((n) => n.key);
    expect(new Set(keys).size).toBe(keys.length); // no two pages share a "g + key" shortcut
  });
});

const progress = (done: number, total: number, failing = 0) => ({ done, total, failing });
function status(partial: Partial<WarmupStatus>): WarmupStatus {
  return {
    warming: true,
    firstRun: true,
    firstTime: ["gold", "silver"],
    startedAt: 1,
    finishedAt: null,
    steps: [
      { id: "gold-quote", metal: "gold", label: "gold price", state: "done", ms: 900 },
      { id: "silver-quote", metal: "silver", label: "silver price", state: "running", ms: null },
      { id: "gold-hourly", metal: "gold", label: "gold 1h chart", state: "pending", ms: null },
      { id: "silver-hourly", metal: "silver", label: "silver 1h chart", state: "pending", ms: null },
    ],
    goldGaps: false,
    silverGaps: false,
    unavailable: [],
    dollarIndex: "pending",
    archive: { gold: progress(10, 24), silver: progress(4, 24), other: progress(0, 96), active: 3, queued: 30, state: "ok", resumesAt: null, nextRetryAt: null },
    ...partial,
  };
}

describe("first-start notice wording", () => {
  it("names both metals on a first start and counts the files of both", () => {
    const w = describeWarmup(status({}));
    expect(w.title).toBe("First start on this computer.");
    expect(w.names).toBe("gold and silver");
    expect(w.once).toBe(true);
    expect(w.files).toEqual({ done: 14, total: 48, failing: 0 });
    expect([w.partsDone, w.partsTotal, w.current]).toEqual([1, 4, "silver price"]);
    expect(w.slow).toBe(false);
  });
  it("names only silver when gold is already there (an install updated to include silver)", () => {
    const base = status({});
    const w = describeWarmup({ ...base, firstRun: false, firstTime: ["silver"], steps: base.steps.map((s) => (s.metal === "gold" ? { ...s, state: "done" as const } : s)), archive: { ...base.archive, gold: progress(2, 2) } });
    expect(w.title).toBe("Downloading silver history for the first time.");
    expect(w.names).toBe("silver");
    expect(w.once).toBe(true);
    expect(w.files).toEqual({ done: 4, total: 24, failing: 0 }); // gold's files are not counted
  });
  it("calls a later start an update, and says so when the archive is slow", () => {
    const base = status({});
    const w = describeWarmup({ ...base, firstRun: false, firstTime: [], archive: { ...base.archive, state: "paused", silver: progress(4, 24, 3) } });
    expect(w.title).toBe("Updating gold and silver history.");
    expect(w.once).toBe(false);
    expect(w.slow).toBe(true);
    expect(w.files.failing).toBe(3);
  });
  it("is not slowed by trouble with dollar-index files, which are background work", () => {
    const base = status({});
    expect(describeWarmup({ ...base, archive: { ...base.archive, other: progress(0, 96, 9) } }).slow).toBe(false);
  });
  it("reports gaps per metal with that metal's refused files", () => {
    const base = status({ warming: false });
    expect(describeGaps(base).metals).toEqual([]);
    const silverOnly = describeGaps({ ...base, silverGaps: true, archive: { ...base.archive, gold: progress(24, 24), silver: progress(20, 24, 4) } });
    expect(silverOnly).toEqual({ metals: ["silver"], names: "silver", failing: 4 });
    const both = describeGaps({ ...base, goldGaps: true, silverGaps: true, archive: { ...base.archive, gold: progress(22, 24, 2), silver: progress(20, 24, 4) } });
    expect(both).toEqual({ metals: ["gold", "silver"], names: "gold and silver", failing: 6 });
  });
  it("names the metals whose history could not be downloaded at all, with the next attempt", () => {
    const base = status({ warming: false });
    expect(describeUnavailable(base).metals).toEqual([]);
    const out = describeUnavailable({ ...base, unavailable: ["silver", "gold"], archive: { ...base.archive, state: "paused", resumesAt: Date.now() + 90_500 } });
    expect(out.metals).toEqual(["gold", "silver"]);
    expect(out.names).toBe("gold and silver");
    expect(out.retryInSeconds).toBeGreaterThanOrEqual(89);
    expect(out.retryInSeconds).toBeLessThanOrEqual(91);
    expect(describeUnavailable({ ...base, unavailable: ["silver"] })).toEqual({ metals: ["silver"], names: "silver", retryInSeconds: null });
    // A status from a server that predates this field is read as "nothing is out".
    expect(describeUnavailable({ ...base, unavailable: undefined as unknown as [] }).metals).toEqual([]);
  });
  it("tells 'unavailable' (shown as an error with its reason) from 'still downloading' (keeps loading)", () => {
    const unavailable = new ApiError(202, "Spot silver price history could not be downloaded yet", { unavailable: true, error: "…" });
    const warming = new ApiError(202, "Spot-silver price history is being downloaded", { warming: true, error: "…" });
    expect(isUnavailableError(unavailable)).toBe(true);
    expect(isWarmingError(unavailable)).toBe(false);
    expect(isUnavailableError(warming)).toBe(false);
    expect(isUnavailableError(new Error("boom"))).toBe(false);
  });
});

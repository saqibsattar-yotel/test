/**
 * Wording of the first-start notice, kept apart from the component so it can be tested: which metals
 * are still downloading, how many of their files are in, and what is being served with gaps.
 */
import type { Metal } from "@terminal/core";
import type { WarmupStatus } from "./api";

const NAME: Record<Metal, string> = { gold: "gold", silver: "silver" };
const ORDER: Metal[] = ["gold", "silver"];

export const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const list = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** While history is downloading: which metals, whether for the first time, and the file count of exactly those metals. */
export function describeWarmup(data: WarmupStatus) {
  const pending = new Set(data.steps.filter((s) => s.state !== "done" && s.state !== "failed").map((s) => s.metal));
  // Between the last step finishing and the status flipping, nothing is pending: name whatever was planned.
  const involved = pending.size ? pending : new Set(data.steps.map((s) => s.metal));
  // Always "gold and silver", whichever happens to have a part outstanding first.
  const metals = ORDER.filter((m) => involved.has(m));
  const firstTime = metals.filter((m) => data.firstTime.includes(m));
  const files = metals.reduce((sum, m) => ({ done: sum.done + data.archive[m].done, total: sum.total + data.archive[m].total, failing: sum.failing + data.archive[m].failing }), { done: 0, total: 0, failing: 0 });
  const title = data.firstRun ? "First start on this computer." : firstTime.length ? `Downloading ${list(firstTime.map((m) => NAME[m]))} history for the first time.` : `Updating ${list(metals.map((m) => NAME[m]))} history.`;
  return {
    metals,
    /** "gold", "silver" or "gold and silver". */
    names: list(metals.map((m) => NAME[m])),
    title,
    /** True when at least one of these metals has never been downloaded on this machine. */
    once: firstTime.length > 0,
    files,
    partsDone: data.steps.filter((s) => s.state === "done").length,
    partsTotal: data.steps.length,
    current: data.steps.find((s) => s.state === "running")?.label ?? null,
    /** The archive is pausing or refusing files of these metals: the download takes longer than usual. */
    slow: data.archive.state !== "ok" || files.failing > 0,
  };
}

/** After the download: which metals are being served with gaps, and how many of their files are still refused. */
export function describeGaps(data: WarmupStatus) {
  const metals: Metal[] = [...(data.goldGaps ? (["gold"] as const) : []), ...(data.silverGaps ? (["silver"] as const) : [])];
  return { metals, names: list(metals.map((m) => NAME[m])), failing: metals.reduce((n, m) => n + data.archive[m].failing, 0) };
}

/** Metals of which nothing at all could be downloaded: their charts and analysis are unavailable, prices are not. */
export function describeUnavailable(data: WarmupStatus) {
  const metals = ORDER.filter((m) => (data.unavailable ?? []).includes(m));
  return { metals, names: list(metals.map((m) => NAME[m])), retryInSeconds: data.archive.resumesAt ? Math.max(0, Math.round((data.archive.resumesAt - Date.now()) / 1000)) : null };
}

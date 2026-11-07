/**
 * Timezone utilities built on the platform Intl API (no dependencies).
 * All instants are epoch milliseconds (UTC). Zones are IANA names.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(zone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    dtfCache.set(zone, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(epochMs: number, zone: string): ZonedParts {
  const parts = getFormatter(zone).formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour: parseInt(get("hour"), 10) % 24,
    minute: parseInt(get("minute"), 10),
    second: parseInt(get("second"), 10),
    weekday: WEEKDAYS.indexOf(get("weekday")),
  };
}

/** Offset of `zone` from UTC in minutes at the given instant (positive east of UTC). */
export function zoneOffsetMinutes(epochMs: number, zone: string): number {
  const p = zonedParts(epochMs, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
}

/**
 * Converts a wall-clock time in `zone` to an epoch instant. Handles DST by iterating
 * the offset guess twice (sufficient for all real zones).
 */
export function zonedTimeToUtc(parts: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number }, zone: string): number {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
  let guess = naive - zoneOffsetMinutes(naive, zone) * 60_000;
  guess = naive - zoneOffsetMinutes(guess, zone) * 60_000;
  return guess;
}

export function formatInZone(epochMs: number, zone: string, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", ...opts }).format(new Date(epochMs));
}

/** Short zone abbreviation (e.g. "GMT", "EST", "GMT+1") at an instant. */
export function zoneAbbreviation(epochMs: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" }).formatToParts(new Date(epochMs));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? zone;
}

/** Start of the UTC day containing the instant. */
export function startOfUtcDay(epochMs: number): number {
  return Math.floor(epochMs / 86_400_000) * 86_400_000;
}

/** Start of the ISO week (Monday 00:00 UTC) containing the instant. */
export function startOfUtcWeek(epochMs: number): number {
  const d = new Date(epochMs);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return startOfUtcDay(epochMs) - dow * 86_400_000;
}

/** Start of the local day in `zone` containing the instant. */
export function startOfZonedDay(epochMs: number, zone: string): number {
  const p = zonedParts(epochMs, zone);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day }, zone);
}

export function humanDuration(ms: number): string {
  const abs = Math.abs(ms);
  const s = Math.round(abs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

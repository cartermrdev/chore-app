/**
 * Calendar maths for the Schedule engine: local dates in a Household time
 * zone, and the instants where they start. Pure; uses Intl for time zones.
 */

/** A calendar date in the Household's time zone, "YYYY-MM-DD". */
export type LocalDate = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLocalDate(value: unknown): value is LocalDate {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.toISOString().slice(0, 10) === value;
}

function toUtcMidnight(date: LocalDate): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Not a LocalDate: ${date}`);
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return new Date(toUtcMidnight(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round((toUtcMidnight(b) - toUtcMidnight(a)) / 86_400_000);
}

/** The given day of a month (1-based month), clamped to the month's last day. */
export function dayOfMonth(year: number, month: number, day: number): LocalDate {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

/** ISO weekday of the date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: LocalDate): number {
  return ((new Date(toUtcMidnight(date)).getUTCDay() + 6) % 7) + 1;
}

/** The Monday on or before the date. */
export function mondayOf(date: LocalDate): LocalDate {
  return addDays(date, 1 - isoWeekday(date));
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function localParts(instant: Date, timeZone: string) {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) parts[p.type] = p.value;
  return parts;
}

/** The local calendar date of an instant in the time zone. */
export function localDateOf(instant: Date, timeZone: string): LocalDate {
  const p = localParts(instant, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Offset of the zone from UTC at the instant, in ms (e.g. +3_600_000 for BST). */
function offsetAt(instant: number, timeZone: string): number {
  const p = localParts(new Date(instant), timeZone);
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The first instant of the local date in the time zone. Usually local
 * midnight; when a DST gap swallows midnight, the first instant after the gap.
 */
export function startOfLocalDay(date: LocalDate, timeZone: string): Date {
  const guess = toUtcMidnight(date);
  // Candidates from the offsets around the guess; the earliest that falls on `date` is its
  // start (in a DST gap that swallows midnight, this is the instant the clocks jump).
  const candidates = [
    guess - offsetAt(guess, timeZone),
    guess - offsetAt(guess - offsetAt(guess, timeZone), timeZone),
    guess - offsetAt(guess - 86_400_000, timeZone),
    guess - offsetAt(guess + 86_400_000, timeZone),
  ]
    .filter((t) => localDateOf(new Date(t), timeZone) === date)
    .sort((a, b) => a - b);
  const first = candidates[0];
  if (first === undefined) throw new Error(`Cannot find the start of ${date} in ${timeZone}`);
  return new Date(first);
}

/** A local time of day, "HH:MM" (24-hour, 00:00–23:59). */
export type LocalTime = string;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isLocalTime(value: unknown): value is LocalTime {
  return typeof value === "string" && TIME_RE.test(value);
}

/**
 * The instant at which the local date and time occur in the time zone.
 * A time the clocks skip (spring DST gap) moves forward by the gap's length;
 * a time that occurs twice (autumn) resolves to its first occurrence.
 */
export function localDateTimeToInstant(date: LocalDate, time: LocalTime, timeZone: string): Date {
  const t = TIME_RE.exec(time);
  if (!t) throw new Error(`Not a LocalTime: ${time}`);
  const wall = toUtcMidnight(date) + (+t[1]! * 60 + +t[2]!) * 60_000;
  const before = wall - offsetAt(wall - 86_400_000, timeZone);
  const after = wall - offsetAt(wall + 86_400_000, timeZone);
  const showsWall = (instant: number) => instant + offsetAt(instant, timeZone) === wall;
  const valid = [before, after].filter(showsWall).sort((a, b) => a - b);
  // In a gap neither offset shows the wall time; the pre-transition offset moves it forward.
  return new Date(valid[0] ?? before);
}

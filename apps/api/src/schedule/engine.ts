/**
 * Schedule engine: pure and deterministic, no I/O, no clock.
 *
 * Given a Schedule definition, the Pauses that apply, the Household time
 * zone, the last Completion (for Interval Schedules) and a reference point,
 * it returns the Occurrences that should exist up to a horizon. It owns all
 * calendar maths (time zones, DST, month ends).
 *
 * Supported so far: One-off, Interval, and Fixed "every N days", "selected
 * weekdays every N weeks" and "monthly on day X" (clamped to the last day of
 * short months).
 *
 * Interval: the first Occurrence falls due on `startDate`; each later one
 * falls due `periodDays` after the local date of the latest Occurrence's
 * Completion (so an Early Completion restarts the period), and never on or
 * before the latest stored due date. While the latest Occurrence has no
 * Completion there is no next one. Interval and One-off Occurrences have no
 * Window end: they stay Open until completed and are never Missed.
 *
 * Adding a Fixed kind:
 *   1. add a member to `FixedRule`,
 *   2. add a case to `fixedDueDates` yielding its due dates in order,
 *   3. add a case to `parseFixedRule` so the API accepts it.
 * Windows, Due Times, horizons and `after` are handled generically.
 */
import {
  addDays,
  compareDates,
  dayOfMonth,
  daysBetween,
  isLocalDate,
  isLocalTime,
  localDateOf,
  localDateTimeToInstant,
  mondayOf,
  startOfLocalDay,
  type LocalDate,
  type LocalTime,
} from "./calendar";

export type { LocalDate, LocalTime } from "./calendar";

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type FixedRule =
  | { type: "every_n_days"; n: number }
  /**
   * On the selected weekdays of every Nth week. Weeks run Monday to Sunday,
   * and the week containing startDate is the first week (so "fortnightly"
   * is anchored on startDate).
   */
  | { type: "weekdays"; weekdays: Weekday[]; n: number }
  /** Every month on this day (1–31); a day the month lacks falls on its last day. */
  | { type: "monthly"; day: number };

/**
 * A named time of day within a Fixed Schedule. Each due date produces one
 * Occurrence per slot, due at the slot's start (with a Grace Period).
 */
export type TimeSlot = {
  name: string;
  start: LocalTime;
  /** The Person copied onto each new Occurrence of this slot; null leaves it unassigned. */
  assigneeId: string | null;
};

export type FixedSchedule = {
  kind: "fixed";
  /** The first possible due date (in the Household time zone). */
  startDate: LocalDate;
  rule: FixedRule;
  /** Non-empty and sorted by start when present; absent means day-level Occurrences. */
  slots?: TimeSlot[];
};

export type OneOffSchedule = { kind: "one_off"; dueDate: LocalDate };

export type IntervalSchedule = {
  kind: "interval";
  /** When the first Occurrence falls due (in the Household time zone). */
  startDate: LocalDate;
  /** Days from one Completion to the next Occurrence's due date. */
  periodDays: number;
};

export type Schedule = FixedSchedule | IntervalSchedule | OneOffSchedule;

export type Pause = { startDate: LocalDate; endDate: LocalDate | null };

export type ScheduleInput = {
  schedule: Schedule;
  timeZone: string;
  pauses: Pause[];
  /**
   * Interval only: when the latest stored Occurrence (the one whose Window
   * opened at `after`) was completed; null when it has no active Completion.
   */
  lastCompletionAt: Date | null;
  /** Only Occurrences whose Window opens strictly after this instant (null: from the start). */
  after: Date | null;
  /** Only Occurrences whose Window opens at or before this instant. */
  horizon: Date;
  /** At most this many Occurrences. */
  limit?: number;
};

export type PlannedOccurrence = {
  dueDate: LocalDate;
  timeSlot: string | null;
  /** When the Occurrence becomes due and can be completed. */
  windowStart: Date;
  /** After this (plus any Grace Period) a Completion is Late. */
  dueTime: Date;
  /** End of the Window (exclusive); null for One-off Occurrences, which are never Missed. */
  windowEnd: Date | null;
};

export function occurrencesUpTo(input: ScheduleInput): PlannedOccurrence[] {
  const limit = input.limit ?? Infinity;
  const all = planned(input);
  const out: PlannedOccurrence[] = [];
  for (const occ of all) {
    if (out.length >= limit) break;
    if (occ.windowStart > input.horizon) break;
    if (input.after && occ.windowStart <= input.after) continue;
    out.push(occ);
  }
  return out;
}

/** All Occurrences in Window order, lazily. Callers stop at the horizon. */
function* planned(input: ScheduleInput): Generator<PlannedOccurrence> {
  const { schedule, timeZone } = input;
  switch (schedule.kind) {
    case "one_off":
      yield {
        dueDate: schedule.dueDate,
        timeSlot: null,
        windowStart: startOfLocalDay(schedule.dueDate, timeZone),
        dueTime: startOfLocalDay(addDays(schedule.dueDate, 1), timeZone),
        windowEnd: null,
      };
      return;
    case "interval": {
      let dueDate: LocalDate;
      if (!input.after) dueDate = schedule.startDate;
      else if (!input.lastCompletionAt) return; // the latest Occurrence is still outstanding
      else {
        const fromCompletion = addDays(localDateOf(input.lastCompletionAt, timeZone), schedule.periodDays);
        const afterLatest = addDays(localDateOf(input.after, timeZone), 1);
        dueDate = compareDates(fromCompletion, afterLatest) >= 0 ? fromCompletion : afterLatest;
      }
      yield {
        dueDate,
        timeSlot: null,
        windowStart: startOfLocalDay(dueDate, timeZone),
        dueTime: startOfLocalDay(addDays(dueDate, 1), timeZone),
        windowEnd: null,
      };
      return;
    }
    case "fixed": {
      // Skip straight to the neighbourhood of `after` instead of walking from startDate.
      const from = input.after ? addDays(localDateOf(input.after, timeZone), -1) : schedule.startDate;
      const entries = fixedEntries(schedule, from, timeZone);
      let current = entries.next();
      while (!current.done) {
        const next = entries.next();
        // ADR 0003: a Fixed Window runs until the next Occurrence's Window opens.
        yield { ...current.value, windowEnd: next.done ? null : next.value.windowStart };
        current = next;
      }
      return;
    }
  }
}

/**
 * A Fixed Schedule's Occurrences (without Window ends) in order: one per due
 * date, or one per Time Slot of each due date, due at the slot's start.
 */
function* fixedEntries(
  schedule: FixedSchedule,
  from: LocalDate,
  timeZone: string,
): Generator<Omit<PlannedOccurrence, "windowEnd">> {
  const slots = [...(schedule.slots ?? [])].sort((a, b) => (a.start < b.start ? -1 : 1));
  for (const dueDate of fixedDueDates(schedule, from)) {
    if (slots.length === 0) {
      yield {
        dueDate,
        timeSlot: null,
        windowStart: startOfLocalDay(dueDate, timeZone),
        dueTime: startOfLocalDay(addDays(dueDate, 1), timeZone),
      };
      continue;
    }
    for (const slot of slots) {
      const start = localDateTimeToInstant(dueDate, slot.start, timeZone);
      yield { dueDate, timeSlot: slot.name, windowStart: start, dueTime: start };
    }
  }
}

/** The due dates of a Fixed Schedule on or after `from` (and on or after its startDate), ascending. */
function* fixedDueDates(schedule: FixedSchedule, from: LocalDate): Generator<LocalDate> {
  const start = compareDates(from, schedule.startDate) > 0 ? from : schedule.startDate;
  const rule = schedule.rule;
  switch (rule.type) {
    case "every_n_days": {
      const offset = daysBetween(schedule.startDate, start);
      let date = addDays(schedule.startDate, Math.ceil(offset / rule.n) * rule.n);
      while (true) {
        yield date;
        date = addDays(date, rule.n);
      }
    }
    case "weekdays": {
      const firstWeek = mondayOf(schedule.startDate);
      // Start at the beginning of the first matching week on or before `start`.
      const weeksIn = Math.floor(daysBetween(firstWeek, mondayOf(start)) / 7);
      let week = addDays(firstWeek, Math.floor(weeksIn / rule.n) * rule.n * 7);
      const days = [...rule.weekdays].sort((a, b) => a - b);
      while (true) {
        for (const wd of days) {
          const date = addDays(week, wd - 1);
          if (compareDates(date, start) >= 0) yield date;
        }
        week = addDays(week, rule.n * 7);
      }
    }
    case "monthly": {
      let [year, month] = start.split("-").map(Number) as [number, number];
      while (true) {
        const date = dayOfMonth(year, month, rule.day);
        if (compareDates(date, start) >= 0) yield date;
        if (++month > 12) {
          month = 1;
          year++;
        }
      }
    }
  }
}

export type ParseResult = { ok: true; schedule: Schedule } | { ok: false; error: string };

/**
 * Validates an untrusted Schedule definition (e.g. a request body).
 * `defaultStartDate` fills in a missing Fixed startDate.
 */
export function parseSchedule(raw: unknown, defaultStartDate: LocalDate): ParseResult {
  const s = raw as any;
  if (!s || typeof s !== "object") return { ok: false, error: "schedule is required" };
  switch (s.kind) {
    case "one_off":
      if (!isLocalDate(s.dueDate)) return { ok: false, error: "dueDate must be YYYY-MM-DD" };
      if (s.slots !== undefined) return { ok: false, error: "only Fixed Schedules have Time Slots" };
      return { ok: true, schedule: { kind: "one_off", dueDate: s.dueDate } };
    case "interval": {
      const startDate = s.startDate ?? defaultStartDate;
      if (!isLocalDate(startDate)) return { ok: false, error: "startDate must be YYYY-MM-DD" };
      if (!Number.isInteger(s.periodDays) || s.periodDays < 1 || s.periodDays > 3660) {
        return { ok: false, error: "periodDays must be an integer from 1 to 3660" };
      }
      return { ok: true, schedule: { kind: "interval", startDate, periodDays: s.periodDays } };
    }
    case "fixed": {
      const startDate = s.startDate ?? defaultStartDate;
      if (!isLocalDate(startDate)) return { ok: false, error: "startDate must be YYYY-MM-DD" };
      const rule = parseFixedRule(s.rule);
      if (typeof rule === "string") return { ok: false, error: rule };
      const slots = parseSlots(s.slots);
      if (typeof slots === "string") return { ok: false, error: slots };
      return { ok: true, schedule: { kind: "fixed", startDate, rule, ...(slots.length ? { slots } : {}) } };
    }
    default:
      return { ok: false, error: "unknown schedule kind" };
  }
}

/** Time Slots: names and starts distinct; sorted by start. Assignee ids are checked by the caller. */
function parseSlots(raw: unknown): TimeSlot[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 24) return "slots must be a list of at most 24 Time Slots";
  const slots: TimeSlot[] = [];
  for (const r of raw as any[]) {
    const name = typeof r?.name === "string" ? r.name.trim() : "";
    if (!name || name.length > 50) return "each Time Slot needs a name of 1 to 50 characters";
    if (!isLocalTime(r.start)) return "each Time Slot needs a start time HH:MM";
    const assigneeId = r.assigneeId ?? null;
    if (assigneeId !== null && typeof assigneeId !== "string") return "assigneeId must be a Person id or null";
    slots.push({ name, start: r.start, assigneeId });
  }
  if (new Set(slots.map((s) => s.name)).size !== slots.length) return "Time Slot names must be distinct";
  if (new Set(slots.map((s) => s.start)).size !== slots.length) return "Time Slot start times must be distinct";
  return slots.sort((a, b) => (a.start < b.start ? -1 : 1));
}

/** Every Assignee named by the Schedule's Time Slots. */
export function slotAssigneeIds(schedule: Schedule): string[] {
  if (schedule.kind !== "fixed" || !schedule.slots) return [];
  return schedule.slots.flatMap((s) => (s.assigneeId ? [s.assigneeId] : []));
}

function parseFixedRule(raw: any): FixedRule | string {
  switch (raw?.type) {
    case "every_n_days":
      if (!Number.isInteger(raw.n) || raw.n < 1 || raw.n > 366) return "n must be an integer from 1 to 366";
      return { type: "every_n_days", n: raw.n };
    case "weekdays": {
      if (!Number.isInteger(raw.n) || raw.n < 1 || raw.n > 52) return "n must be an integer from 1 to 52";
      const days = raw.weekdays;
      if (
        !Array.isArray(days) ||
        days.length === 0 ||
        !days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7) ||
        new Set(days).size !== days.length
      ) {
        return "weekdays must be distinct ISO weekdays from 1 (Monday) to 7 (Sunday)";
      }
      return { type: "weekdays", weekdays: [...days].sort((a, b) => a - b) as Weekday[], n: raw.n };
    }
    case "monthly":
      if (!Number.isInteger(raw.day) || raw.day < 1 || raw.day > 31) return "day must be an integer from 1 to 31";
      return { type: "monthly", day: raw.day };
    default:
      return "unknown fixed rule type";
  }
}

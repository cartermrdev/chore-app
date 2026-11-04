/**
 * Schedule engine: pure and deterministic, no I/O, no clock.
 *
 * Given a Schedule definition, the Pauses that apply, the Household time
 * zone, the last Completion (for Interval Schedules) and a reference point,
 * it returns the Occurrences that should exist up to a horizon. It owns all
 * calendar maths (time zones, DST, month ends).
 *
 * Supported so far: One-off, Interval, and Fixed "every N days".
 *
 * Interval: the first Occurrence falls due on `startDate`; each later one
 * falls due `periodDays` after the local date of the latest Occurrence's
 * Completion (so an Early Completion restarts the period), and never on or
 * before the latest stored due date. While the latest Occurrence has no
 * Completion there is no next one. Interval and One-off Occurrences have no
 * Window end: they stay Open until completed and are never Missed.
 *
 * Adding a Fixed kind (e.g. weekdays every N weeks, monthly day X):
 *   1. add a member to `FixedRule`,
 *   2. add a case to `fixedDueDates` yielding its due dates in order,
 *   3. add a case to `parseFixedRule` so the API accepts it.
 * Windows, Due Times, horizons and `after` are handled generically.
 */
import { addDays, compareDates, daysBetween, isLocalDate, localDateOf, startOfLocalDay, type LocalDate } from "./calendar";

export type { LocalDate } from "./calendar";

export type FixedRule = { type: "every_n_days"; n: number };

export type FixedSchedule = {
  kind: "fixed";
  /** The first possible due date (in the Household time zone). */
  startDate: LocalDate;
  rule: FixedRule;
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
      const dates = fixedDueDates(schedule, from);
      let current = dates.next();
      while (!current.done) {
        const next = dates.next();
        const dueDate = current.value;
        // ADR 0003: a Fixed Window runs until the next Occurrence's Window opens.
        const windowEnd = next.done ? null : startOfLocalDay(next.value, timeZone);
        yield {
          dueDate,
          timeSlot: null,
          windowStart: startOfLocalDay(dueDate, timeZone),
          dueTime: startOfLocalDay(addDays(dueDate, 1), timeZone),
          windowEnd,
        };
        current = next;
      }
      return;
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
      return { ok: true, schedule: { kind: "fixed", startDate, rule } };
    }
    default:
      return { ok: false, error: "unknown schedule kind" };
  }
}

function parseFixedRule(raw: any): FixedRule | string {
  switch (raw?.type) {
    case "every_n_days":
      if (!Number.isInteger(raw.n) || raw.n < 1 || raw.n > 366) return "n must be an integer from 1 to 366";
      return { type: "every_n_days", n: raw.n };
    default:
      return "unknown fixed rule type";
  }
}

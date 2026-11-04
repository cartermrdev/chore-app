/**
 * Schedule engine (Seam 2): Interval Schedules. The next Occurrence falls due
 * a period after the previous Completion, so `lastCompletionAt` drives it.
 * `lastCompletionAt` is the active Completion of the latest stored Occurrence
 * (null when that Occurrence has none).
 */
import { describe, expect, test } from "bun:test";
import { occurrencesUpTo, type PlannedOccurrence, type ScheduleInput } from "./engine";

const at = (iso: string) => new Date(iso);
const far = at("2100-01-01T00:00:00Z");

/** Interval Occurrences are day-level and never Missed: no Window end. */
const day = (dueDate: string, windowStart: string, dueTime: string): PlannedOccurrence => ({
  dueDate,
  timeSlot: null,
  windowStart: at(windowStart),
  dueTime: at(dueTime),
  windowEnd: null,
});

const every = (periodDays: number, startDate = "2026-03-01") => ({ kind: "interval" as const, startDate, periodDays });

const cases: { name: string; input: ScheduleInput; expected: PlannedOccurrence[] }[] = [
  {
    name: "with no Completion yet, the first Occurrence falls due on the start date and stays Open",
    input: {
      schedule: every(30),
      timeZone: "Europe/London",
      pauses: [],
      lastCompletionAt: null,
      after: null,
      horizon: far,
    },
    expected: [day("2026-03-01", "2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z")],
  },
  {
    name: "the next Occurrence falls due one period after the Completion's local date (across BST)",
    input: {
      schedule: every(30),
      timeZone: "Europe/London",
      pauses: [],
      lastCompletionAt: at("2026-03-05T10:00:00Z"), // completed 4 days late
      after: at("2026-03-01T00:00:00Z"),
      horizon: far,
    },
    expected: [day("2026-04-04", "2026-04-03T23:00:00Z", "2026-04-04T23:00:00Z")],
  },
  {
    name: "the Completion's date is taken in the Household time zone (late evening in New York)",
    input: {
      schedule: every(1),
      timeZone: "America/New_York",
      pauses: [],
      lastCompletionAt: at("2026-03-02T03:00:00Z"), // 22:00 on 03-01 in New York
      after: at("2026-03-01T05:00:00Z"),
      horizon: far,
    },
    expected: [day("2026-03-02", "2026-03-02T05:00:00Z", "2026-03-03T05:00:00Z")],
  },
  {
    name: "while the latest Occurrence has no Completion, there is no next one",
    input: {
      schedule: every(7),
      timeZone: "Europe/London",
      pauses: [],
      lastCompletionAt: null,
      after: at("2026-03-01T00:00:00Z"),
      horizon: far,
    },
    expected: [],
  },
  {
    name: "the next Occurrence is not returned before its Window opens (horizon)",
    input: {
      schedule: every(7),
      timeZone: "Europe/London",
      pauses: [],
      lastCompletionAt: at("2026-03-01T10:00:00Z"),
      after: at("2026-03-01T00:00:00Z"),
      horizon: at("2026-03-07T23:59:59Z"),
    },
    expected: [],
  },
  {
    name: "after an Early Completion the period restarts, but never on or before the latest stored due date",
    input: {
      // The Occurrence due 03-02 was completed early on 03-01; one day later is 03-02 again.
      schedule: every(1),
      timeZone: "Europe/London",
      pauses: [],
      lastCompletionAt: at("2026-03-01T09:00:00Z"),
      after: at("2026-03-02T00:00:00Z"),
      horizon: far,
    },
    expected: [day("2026-03-03", "2026-03-03T00:00:00Z", "2026-03-04T00:00:00Z")],
  },
];

describe("Schedule engine: Interval", () => {
  for (const c of cases) {
    test(c.name, () => {
      expect(occurrencesUpTo(c.input)).toEqual(c.expected);
    });
  }
});

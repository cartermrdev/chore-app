/**
 * Schedule engine (Seam 2): Pauses. A Pause covers its start date through its
 * end date (inclusive; null = indefinite) in the Household time zone.
 *
 * - Fixed: Occurrences inside a Pause are still planned (the materialiser
 *   stores them as Skipped); `nextOccurrence` skips over them.
 * - Interval: the clock keeps running; a due date that lands inside a Pause
 *   moves to the Pause's end (the day after its end date) and stays Open.
 */
import { describe, expect, test } from "bun:test";
import { nextOccurrence, occurrencesUpTo, type PlannedOccurrence, type ScheduleInput } from "./engine";

const at = (iso: string) => new Date(iso);
const far = at("2100-01-01T00:00:00Z");

const day = (dueDate: string, windowStart: string, dueTime: string, windowEnd: string | null): PlannedOccurrence => ({
  dueDate,
  timeSlot: null,
  windowStart: at(windowStart),
  dueTime: at(dueTime),
  windowEnd: windowEnd === null ? null : at(windowEnd),
});

const interval = (periodDays: number, startDate = "2026-03-01") => ({ kind: "interval" as const, startDate, periodDays });
const daily = { kind: "fixed" as const, startDate: "2026-03-01", rule: { type: "every_n_days" as const, n: 1 } };

describe("Schedule engine: Interval through a Pause", () => {
  const cases: { name: string; input: ScheduleInput; expected: PlannedOccurrence[] }[] = [
    {
      name: "the clock keeps running: a due date after the Pause is unaffected",
      input: {
        schedule: interval(10),
        timeZone: "Europe/London",
        pauses: [{ startDate: "2026-03-03", endDate: "2026-03-07" }],
        lastCompletionAt: at("2026-03-01T10:00:00Z"),
        after: at("2026-03-01T00:00:00Z"),
        horizon: far,
      },
      expected: [day("2026-03-11", "2026-03-11T00:00:00Z", "2026-03-12T00:00:00Z", null)],
    },
    {
      name: "a due date inside a Pause moves to the Pause's end and stays Open (no Window end)",
      input: {
        schedule: interval(5),
        timeZone: "Europe/London",
        pauses: [{ startDate: "2026-03-03", endDate: "2026-03-09" }],
        lastCompletionAt: at("2026-03-01T10:00:00Z"),
        after: at("2026-03-01T00:00:00Z"),
        horizon: far,
      },
      expected: [day("2026-03-10", "2026-03-10T00:00:00Z", "2026-03-11T00:00:00Z", null)],
    },
    {
      name: "the Pause's end is taken in the Household time zone (across BST)",
      input: {
        schedule: interval(30),
        timeZone: "Europe/London",
        pauses: [{ startDate: "2026-03-25", endDate: "2026-04-05" }],
        lastCompletionAt: at("2026-03-01T10:00:00Z"),
        after: at("2026-03-01T00:00:00Z"),
        horizon: far,
      },
      expected: [day("2026-04-06", "2026-04-05T23:00:00Z", "2026-04-06T23:00:00Z", null)],
    },
    {
      name: "back-to-back Pauses: it moves past both",
      input: {
        schedule: interval(5),
        timeZone: "Europe/London",
        pauses: [
          { startDate: "2026-03-10", endDate: "2026-03-14" },
          { startDate: "2026-03-05", endDate: "2026-03-09" },
        ],
        lastCompletionAt: at("2026-03-01T10:00:00Z"),
        after: at("2026-03-01T00:00:00Z"),
        horizon: far,
      },
      expected: [day("2026-03-15", "2026-03-15T00:00:00Z", "2026-03-16T00:00:00Z", null)],
    },
    {
      name: "the first Occurrence's start date inside a Pause also moves to its end",
      input: {
        schedule: interval(5, "2026-03-02"),
        timeZone: "Europe/London",
        pauses: [{ startDate: "2026-03-01", endDate: "2026-03-03" }],
        lastCompletionAt: null,
        after: null,
        horizon: far,
      },
      expected: [day("2026-03-04", "2026-03-04T00:00:00Z", "2026-03-05T00:00:00Z", null)],
    },
    {
      name: "inside an indefinite Pause nothing falls due until the Pause is given an end",
      input: {
        schedule: interval(5),
        timeZone: "Europe/London",
        pauses: [{ startDate: "2026-03-03", endDate: null }],
        lastCompletionAt: at("2026-03-01T10:00:00Z"),
        after: at("2026-03-01T00:00:00Z"),
        horizon: far,
      },
      expected: [],
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      expect(occurrencesUpTo(c.input)).toEqual(c.expected);
    });
  }
});

describe("Schedule engine: Fixed through a Pause", () => {
  test("Occurrences inside a Pause are still planned (they are stored as Skipped)", () => {
    const planned = occurrencesUpTo({
      schedule: daily,
      timeZone: "Europe/London",
      pauses: [{ startDate: "2026-03-02", endDate: "2026-03-03" }],
      lastCompletionAt: null,
      after: null,
      horizon: at("2026-03-04T00:00:00Z"),
    });
    expect(planned.map((p) => p.dueDate)).toEqual(["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04"]);
  });

  test("the next Occurrence to fall due skips over the Pause", () => {
    const next = nextOccurrence({
      schedule: daily,
      timeZone: "Europe/London",
      pauses: [{ startDate: "2026-03-02", endDate: "2026-03-05" }],
      lastCompletionAt: null,
      after: at("2026-03-01T00:00:00Z"),
    });
    expect(next).toEqual(day("2026-03-06", "2026-03-06T00:00:00Z", "2026-03-07T00:00:00Z", "2026-03-07T00:00:00Z"));
  });

  test("Time Slot Occurrences on a paused date are skipped over too", () => {
    const next = nextOccurrence({
      schedule: { ...daily, slots: [{ name: "Morning", start: "07:00", assigneeId: null }, { name: "Evening", start: "18:00", assigneeId: null }] },
      timeZone: "Europe/London",
      pauses: [{ startDate: "2026-03-01", endDate: "2026-03-01" }],
      lastCompletionAt: null,
      after: null,
    });
    expect(next).toMatchObject({ dueDate: "2026-03-02", timeSlot: "Morning", windowStart: at("2026-03-02T07:00:00Z") });
  });

  test("inside an indefinite Pause nothing is next", () => {
    const next = nextOccurrence({
      schedule: daily,
      timeZone: "Europe/London",
      pauses: [{ startDate: "2026-03-02", endDate: null }],
      lastCompletionAt: null,
      after: at("2026-03-01T00:00:00Z"),
    });
    expect(next).toBeNull();
  });

  test("with no Pause, the next Occurrence is simply the next planned one", () => {
    const next = nextOccurrence({
      schedule: daily,
      timeZone: "Europe/London",
      pauses: [{ startDate: "2026-02-01", endDate: "2026-02-10" }],
      lastCompletionAt: null,
      after: at("2026-03-01T00:00:00Z"),
    });
    expect(next?.dueDate).toBe("2026-03-02");
  });
});

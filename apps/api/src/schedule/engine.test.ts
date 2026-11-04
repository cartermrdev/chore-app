/**
 * Schedule engine (Seam 2): fast, table-driven tests on the pure module.
 * No database, no clock: every input is passed in.
 */
import { describe, expect, test } from "bun:test";
import { occurrencesUpTo, parseSchedule, type ScheduleInput, type PlannedOccurrence } from "./engine";

const base = {
  timeZone: "Europe/London",
  pauses: [],
  lastCompletionAt: null,
  after: null,
};

const at = (iso: string) => new Date(iso);

/** A day-level Occurrence: Window opens at local midnight, Due Time is the end of the day. */
const day = (dueDate: string, windowStart: string, dueTime: string, windowEnd: string | null) => ({
  dueDate,
  timeSlot: null,
  windowStart: at(windowStart),
  dueTime: at(dueTime),
  windowEnd: windowEnd === null ? null : at(windowEnd),
});

const cases: { name: string; input: ScheduleInput; expected: PlannedOccurrence[] }[] = [
  {
    name: "a One-off Schedule has a single Occurrence with no Window end",
    input: {
      ...base,
      schedule: { kind: "one_off", dueDate: "2026-03-10" },
      horizon: at("2026-04-01T00:00:00Z"),
    },
    expected: [day("2026-03-10", "2026-03-10T00:00:00Z", "2026-03-11T00:00:00Z", null)],
  },
  {
    name: "every 1 day: each Window runs from local midnight to the next",
    input: {
      ...base,
      schedule: { kind: "fixed", startDate: "2026-01-05", rule: { type: "every_n_days", n: 1 } },
      horizon: at("2026-01-07T12:00:00Z"),
    },
    expected: [
      day("2026-01-05", "2026-01-05T00:00:00Z", "2026-01-06T00:00:00Z", "2026-01-06T00:00:00Z"),
      day("2026-01-06", "2026-01-06T00:00:00Z", "2026-01-07T00:00:00Z", "2026-01-07T00:00:00Z"),
      day("2026-01-07", "2026-01-07T00:00:00Z", "2026-01-08T00:00:00Z", "2026-01-08T00:00:00Z"),
    ],
  },
  {
    name: "every 1 day across the spring DST change in London (23-hour day)",
    input: {
      ...base,
      schedule: { kind: "fixed", startDate: "2026-03-28", rule: { type: "every_n_days", n: 1 } },
      horizon: at("2026-03-30T00:00:00Z"),
    },
    expected: [
      day("2026-03-28", "2026-03-28T00:00:00Z", "2026-03-29T00:00:00Z", "2026-03-29T00:00:00Z"),
      day("2026-03-29", "2026-03-29T00:00:00Z", "2026-03-29T23:00:00Z", "2026-03-29T23:00:00Z"),
      day("2026-03-30", "2026-03-29T23:00:00Z", "2026-03-30T23:00:00Z", "2026-03-30T23:00:00Z"),
    ],
  },
  {
    name: "every 1 day across the autumn DST change in London (25-hour day)",
    input: {
      ...base,
      schedule: { kind: "fixed", startDate: "2026-10-25", rule: { type: "every_n_days", n: 1 } },
      horizon: at("2026-10-26T00:00:00Z"),
    },
    expected: [
      day("2026-10-25", "2026-10-24T23:00:00Z", "2026-10-26T00:00:00Z", "2026-10-26T00:00:00Z"),
      day("2026-10-26", "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z", "2026-10-27T00:00:00Z"),
    ],
  },
  {
    name: "every 3 days: due at the end of the due date, Window runs until the next due date",
    input: {
      ...base,
      schedule: { kind: "fixed", startDate: "2026-01-01", rule: { type: "every_n_days", n: 3 } },
      horizon: at("2026-01-07T00:00:00Z"),
    },
    expected: [
      day("2026-01-01", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "2026-01-04T00:00:00Z"),
      day("2026-01-04", "2026-01-04T00:00:00Z", "2026-01-05T00:00:00Z", "2026-01-07T00:00:00Z"),
      day("2026-01-07", "2026-01-07T00:00:00Z", "2026-01-08T00:00:00Z", "2026-01-10T00:00:00Z"),
    ],
  },
  {
    name: "nothing before the start date",
    input: {
      ...base,
      schedule: { kind: "fixed", startDate: "2026-02-01", rule: { type: "every_n_days", n: 2 } },
      horizon: at("2026-01-31T12:00:00Z"),
    },
    expected: [],
  },
  {
    name: "`after` skips Occurrences whose Window has already opened, keeping the N-day rhythm",
    input: {
      ...base,
      schedule: { kind: "fixed", startDate: "2025-01-01", rule: { type: "every_n_days", n: 7 } },
      after: at("2026-01-07T00:00:00Z"), // the Window start of 2026-01-07
      horizon: at("2026-01-21T00:00:00Z"),
    },
    expected: [
      day("2026-01-14", "2026-01-14T00:00:00Z", "2026-01-15T00:00:00Z", "2026-01-21T00:00:00Z"),
      day("2026-01-21", "2026-01-21T00:00:00Z", "2026-01-22T00:00:00Z", "2026-01-28T00:00:00Z"),
    ],
  },
  {
    name: "`limit` caps the result (used to look up the next due Occurrence)",
    input: {
      ...base,
      schedule: { kind: "fixed", startDate: "2026-01-01", rule: { type: "every_n_days", n: 2 } },
      after: at("2026-01-01T00:00:00Z"),
      horizon: at("2100-01-01T00:00:00Z"),
      limit: 1,
    },
    expected: [day("2026-01-03", "2026-01-03T00:00:00Z", "2026-01-04T00:00:00Z", "2026-01-05T00:00:00Z")],
  },
  {
    name: "every 2 days in New York across its spring DST change",
    input: {
      ...base,
      timeZone: "America/New_York",
      schedule: { kind: "fixed", startDate: "2026-03-07", rule: { type: "every_n_days", n: 2 } },
      horizon: at("2026-03-09T12:00:00Z"),
    },
    expected: [
      day("2026-03-07", "2026-03-07T05:00:00Z", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"),
      day("2026-03-09", "2026-03-09T04:00:00Z", "2026-03-10T04:00:00Z", "2026-03-11T04:00:00Z"),
    ],
  },
  {
    name: "a day whose midnight is skipped by DST starts when the clocks jump (Santiago)",
    input: {
      ...base,
      timeZone: "America/Santiago",
      // Chile springs forward at 24:00 on 2026-09-05: 2026-09-06 starts at 01:00 (-03).
      schedule: { kind: "fixed", startDate: "2026-09-05", rule: { type: "every_n_days", n: 1 } },
      horizon: at("2026-09-06T12:00:00Z"),
    },
    expected: [
      day("2026-09-05", "2026-09-05T04:00:00Z", "2026-09-06T04:00:00Z", "2026-09-06T04:00:00Z"),
      day("2026-09-06", "2026-09-06T04:00:00Z", "2026-09-07T03:00:00Z", "2026-09-07T03:00:00Z"),
    ],
  },
  {
    // 2026-01-01 is a Thursday.
    name: "selected weekdays every week: bins every Thursday",
    input: {
      ...base,
      schedule: { kind: "fixed", startDate: "2026-01-01", rule: { type: "weekdays", weekdays: [4], n: 1 } },
      horizon: at("2026-01-15T00:00:00Z"),
    },
    expected: [
      day("2026-01-01", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "2026-01-08T00:00:00Z"),
      day("2026-01-08", "2026-01-08T00:00:00Z", "2026-01-09T00:00:00Z", "2026-01-15T00:00:00Z"),
      day("2026-01-15", "2026-01-15T00:00:00Z", "2026-01-16T00:00:00Z", "2026-01-22T00:00:00Z"),
    ],
  },
  {
    // 2026-01-07 is a Wednesday: its week's Monday has passed, so Thursday comes first.
    name: "Monday and Thursday every 2 weeks, starting mid-week",
    input: {
      ...base,
      schedule: { kind: "fixed", startDate: "2026-01-07", rule: { type: "weekdays", weekdays: [4, 1], n: 2 } },
      horizon: at("2026-01-22T00:00:00Z"),
    },
    expected: [
      day("2026-01-08", "2026-01-08T00:00:00Z", "2026-01-09T00:00:00Z", "2026-01-19T00:00:00Z"),
      day("2026-01-19", "2026-01-19T00:00:00Z", "2026-01-20T00:00:00Z", "2026-01-22T00:00:00Z"),
      day("2026-01-22", "2026-01-22T00:00:00Z", "2026-01-23T00:00:00Z", "2026-02-02T00:00:00Z"),
    ],
  },
  {
    name: "fortnightly on Monday keeps its rhythm long after the start date",
    input: {
      ...base,
      // 2026-01-05 is a Monday; 2026-06-08 is 22 weeks later (on), 2026-06-15 is 23 (off).
      schedule: { kind: "fixed", startDate: "2026-01-05", rule: { type: "weekdays", weekdays: [1], n: 2 } },
      after: at("2026-06-01T00:00:00Z"),
      horizon: at("2026-06-30T00:00:00Z"),
    },
    expected: [
      day("2026-06-08", "2026-06-07T23:00:00Z", "2026-06-08T23:00:00Z", "2026-06-21T23:00:00Z"),
      day("2026-06-22", "2026-06-21T23:00:00Z", "2026-06-22T23:00:00Z", "2026-07-05T23:00:00Z"),
    ],
  },
  {
    name: "every Sunday across the spring DST change in London",
    input: {
      ...base,
      // Clocks go forward at 01:00 UTC on Sunday 2026-03-29.
      schedule: { kind: "fixed", startDate: "2026-03-22", rule: { type: "weekdays", weekdays: [7], n: 1 } },
      horizon: at("2026-04-04T22:59:59Z"), // just before 2026-04-05 starts (BST)
    },
    expected: [
      day("2026-03-22", "2026-03-22T00:00:00Z", "2026-03-23T00:00:00Z", "2026-03-29T00:00:00Z"),
      day("2026-03-29", "2026-03-29T00:00:00Z", "2026-03-29T23:00:00Z", "2026-04-04T23:00:00Z"),
    ],
  },
  {
    name: "monthly on day 15",
    input: {
      ...base,
      schedule: { kind: "fixed", startDate: "2026-01-20", rule: { type: "monthly", day: 15 } },
      horizon: at("2026-03-15T00:00:00Z"),
    },
    expected: [
      day("2026-02-15", "2026-02-15T00:00:00Z", "2026-02-16T00:00:00Z", "2026-03-15T00:00:00Z"),
      day("2026-03-15", "2026-03-15T00:00:00Z", "2026-03-16T00:00:00Z", "2026-04-14T23:00:00Z"),
    ],
  },
  {
    name: "monthly on day 31 falls on the last day of shorter months (leap year February too)",
    input: {
      ...base,
      timeZone: "UTC",
      schedule: { kind: "fixed", startDate: "2028-01-01", rule: { type: "monthly", day: 31 } },
      horizon: at("2028-05-31T00:00:00Z"),
    },
    expected: [
      day("2028-01-31", "2028-01-31T00:00:00Z", "2028-02-01T00:00:00Z", "2028-02-29T00:00:00Z"),
      day("2028-02-29", "2028-02-29T00:00:00Z", "2028-03-01T00:00:00Z", "2028-03-31T00:00:00Z"),
      day("2028-03-31", "2028-03-31T00:00:00Z", "2028-04-01T00:00:00Z", "2028-04-30T00:00:00Z"),
      day("2028-04-30", "2028-04-30T00:00:00Z", "2028-05-01T00:00:00Z", "2028-05-31T00:00:00Z"),
      day("2028-05-31", "2028-05-31T00:00:00Z", "2028-06-01T00:00:00Z", "2028-06-30T00:00:00Z"),
    ],
  },
  {
    name: "monthly on day 30 in a non-leap February, with `after` well past the start",
    input: {
      ...base,
      timeZone: "UTC",
      schedule: { kind: "fixed", startDate: "2020-01-01", rule: { type: "monthly", day: 30 } },
      after: at("2027-01-30T00:00:00Z"),
      horizon: at("2027-03-30T00:00:00Z"),
    },
    expected: [
      day("2027-02-28", "2027-02-28T00:00:00Z", "2027-03-01T00:00:00Z", "2027-03-30T00:00:00Z"),
      day("2027-03-30", "2027-03-30T00:00:00Z", "2027-03-31T00:00:00Z", "2027-04-30T00:00:00Z"),
    ],
  },
  {
    name: "monthly in New York across both DST changes",
    input: {
      ...base,
      timeZone: "America/New_York",
      // DST starts 2026-03-08 and ends 2026-11-01 in New York.
      schedule: { kind: "fixed", startDate: "2026-02-01", rule: { type: "monthly", day: 8 } },
      horizon: at("2026-03-08T12:00:00Z"),
    },
    expected: [
      day("2026-02-08", "2026-02-08T05:00:00Z", "2026-02-09T05:00:00Z", "2026-03-08T05:00:00Z"),
      day("2026-03-08", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", "2026-04-08T04:00:00Z"),
    ],
  },
  {
    name: "monthly on day 1 across the autumn DST change in New York",
    input: {
      ...base,
      timeZone: "America/New_York",
      schedule: { kind: "fixed", startDate: "2026-10-01", rule: { type: "monthly", day: 1 } },
      horizon: at("2026-11-01T12:00:00Z"),
    },
    expected: [
      day("2026-10-01", "2026-10-01T04:00:00Z", "2026-10-02T04:00:00Z", "2026-11-01T04:00:00Z"),
      day("2026-11-01", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z", "2026-12-01T05:00:00Z"),
    ],
  },
];

describe("Schedule engine", () => {
  for (const c of cases) {
    test(c.name, () => {
      expect(occurrencesUpTo(c.input)).toEqual(c.expected);
    });
  }
});

/** A Time Slot Occurrence: Window opens and Due Time falls at the slot's start. */
const slot = (dueDate: string, timeSlot: string, windowStart: string, windowEnd: string | null) => ({
  dueDate,
  timeSlot,
  windowStart: at(windowStart),
  dueTime: at(windowStart),
  windowEnd: windowEnd === null ? null : at(windowEnd),
});

const morningEvening = [
  { name: "Morning", start: "06:00", assigneeId: null },
  { name: "Evening", start: "17:00", assigneeId: null },
];

const slotCases: { name: string; input: ScheduleInput; expected: PlannedOccurrence[] }[] = [
  {
    name: "Time Slots: each slot is its own Occurrence, due at its start, with a Window until the next slot starts",
    input: {
      ...base,
      schedule: { kind: "fixed", startDate: "2026-01-05", rule: { type: "every_n_days", n: 1 }, slots: morningEvening },
      horizon: at("2026-01-06T12:00:00Z"),
    },
    expected: [
      slot("2026-01-05", "Morning", "2026-01-05T06:00:00Z", "2026-01-05T17:00:00Z"),
      slot("2026-01-05", "Evening", "2026-01-05T17:00:00Z", "2026-01-06T06:00:00Z"),
      slot("2026-01-06", "Morning", "2026-01-06T06:00:00Z", "2026-01-06T17:00:00Z"),
    ],
  },
  {
    name: "Time Slots are ordered by start time whatever order they were given in",
    input: {
      ...base,
      schedule: {
        kind: "fixed",
        startDate: "2026-01-05",
        rule: { type: "every_n_days", n: 1 },
        slots: [...morningEvening].reverse(),
      },
      horizon: at("2026-01-05T18:00:00Z"),
    },
    expected: [
      slot("2026-01-05", "Morning", "2026-01-05T06:00:00Z", "2026-01-05T17:00:00Z"),
      slot("2026-01-05", "Evening", "2026-01-05T17:00:00Z", "2026-01-06T06:00:00Z"),
    ],
  },
  {
    name: "Time Slots on weekdays: the last slot's Window runs until the next due date's first slot",
    input: {
      ...base,
      // 2026-03-02 is a Monday; due Mondays and Thursdays.
      schedule: { kind: "fixed", startDate: "2026-03-02", rule: { type: "weekdays", weekdays: [1, 4], n: 1 }, slots: morningEvening },
      horizon: at("2026-03-05T12:00:00Z"),
    },
    expected: [
      slot("2026-03-02", "Morning", "2026-03-02T06:00:00Z", "2026-03-02T17:00:00Z"),
      slot("2026-03-02", "Evening", "2026-03-02T17:00:00Z", "2026-03-05T06:00:00Z"),
      slot("2026-03-05", "Morning", "2026-03-05T06:00:00Z", "2026-03-05T17:00:00Z"),
    ],
  },
  {
    name: "Time Slots follow local time across the spring DST change in London",
    input: {
      ...base,
      schedule: { kind: "fixed", startDate: "2026-03-28", rule: { type: "every_n_days", n: 1 }, slots: morningEvening },
      horizon: at("2026-03-29T12:00:00Z"),
    },
    expected: [
      slot("2026-03-28", "Morning", "2026-03-28T06:00:00Z", "2026-03-28T17:00:00Z"),
      slot("2026-03-28", "Evening", "2026-03-28T17:00:00Z", "2026-03-29T05:00:00Z"),
      slot("2026-03-29", "Morning", "2026-03-29T05:00:00Z", "2026-03-29T16:00:00Z"),
    ],
  },
  {
    name: "a Time Slot inside the spring DST gap starts when the clocks jump (01:30 GMT is 02:30 BST)",
    input: {
      ...base,
      schedule: {
        kind: "fixed",
        startDate: "2026-03-29",
        rule: { type: "every_n_days", n: 1 },
        slots: [{ name: "Night", start: "01:30", assigneeId: null }],
      },
      horizon: at("2026-03-30T01:00:00Z"),
    },
    expected: [
      slot("2026-03-29", "Night", "2026-03-29T01:30:00Z", "2026-03-30T00:30:00Z"),
      slot("2026-03-30", "Night", "2026-03-30T00:30:00Z", "2026-03-31T00:30:00Z"),
    ],
  },
  {
    name: "a Time Slot in the repeated autumn hour starts at its first occurrence (01:30 BST)",
    input: {
      ...base,
      schedule: {
        kind: "fixed",
        startDate: "2026-10-25",
        rule: { type: "every_n_days", n: 1 },
        slots: [{ name: "Night", start: "01:30", assigneeId: null }],
      },
      horizon: at("2026-10-25T12:00:00Z"),
    },
    expected: [slot("2026-10-25", "Night", "2026-10-25T00:30:00Z", "2026-10-26T01:30:00Z")],
  },
  {
    name: "Time Slots with `after` at the Morning slot's start: planning resumes at the Evening slot",
    input: {
      ...base,
      schedule: { kind: "fixed", startDate: "2026-01-05", rule: { type: "every_n_days", n: 1 }, slots: morningEvening },
      after: at("2026-01-05T06:00:00Z"),
      horizon: at("2026-01-06T06:00:00Z"),
    },
    expected: [
      slot("2026-01-05", "Evening", "2026-01-05T17:00:00Z", "2026-01-06T06:00:00Z"),
      slot("2026-01-06", "Morning", "2026-01-06T06:00:00Z", "2026-01-06T17:00:00Z"),
    ],
  },
];

describe("Schedule engine: Time Slots", () => {
  for (const c of slotCases) {
    test(c.name, () => {
      expect(occurrencesUpTo(c.input)).toEqual(c.expected);
    });
  }
});

describe("parseSchedule: Time Slots", () => {
  const fixed = (slots: unknown) => ({ kind: "fixed", rule: { type: "every_n_days", n: 1 }, slots });

  test("accepts slots, sorts them by start and defaults a missing Assignee to none", () => {
    const parsed = parseSchedule(fixed([{ name: " Evening ", start: "17:00" }, { name: "Morning", start: "06:00", assigneeId: "p1" }]), "2026-01-01");
    expect(parsed).toEqual({
      ok: true,
      schedule: {
        kind: "fixed",
        startDate: "2026-01-01",
        rule: { type: "every_n_days", n: 1 },
        slots: [
          { name: "Morning", start: "06:00", assigneeId: "p1" },
          { name: "Evening", start: "17:00", assigneeId: null },
        ],
      },
    });
  });

  test("an empty slot list means no Time Slots", () => {
    expect(parseSchedule(fixed([]), "2026-01-01")).toEqual({
      ok: true,
      schedule: { kind: "fixed", startDate: "2026-01-01", rule: { type: "every_n_days", n: 1 } },
    });
  });

  for (const [why, slots] of [
    ["not a list", "Morning"],
    ["a blank name", [{ name: " ", start: "06:00" }]],
    ["a bad start time", [{ name: "Morning", start: "6am" }]],
    ["an out-of-range start time", [{ name: "Morning", start: "24:00" }]],
    ["duplicate names", [{ name: "A", start: "06:00" }, { name: "A", start: "07:00" }]],
    ["duplicate start times", [{ name: "A", start: "06:00" }, { name: "B", start: "06:00" }]],
    ["a non-string Assignee", [{ name: "A", start: "06:00", assigneeId: 5 }]],
  ] as const) {
    test(`rejects ${why}`, () => {
      expect(parseSchedule(fixed(slots), "2026-01-01").ok).toBe(false);
    });
  }

  test("rejects slots on a One-off Schedule", () => {
    expect(parseSchedule({ kind: "one_off", dueDate: "2026-01-01", slots: [{ name: "A", start: "06:00" }] }, "2026-01-01").ok).toBe(false);
  });
});

/**
 * Schedule engine (Seam 2): fast, table-driven tests on the pure module.
 * No database, no clock: every input is passed in.
 */
import { describe, expect, test } from "bun:test";
import { occurrencesUpTo, type ScheduleInput, type PlannedOccurrence } from "./engine";

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

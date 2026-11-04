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
};

const cases: { name: string; input: ScheduleInput; expected: PlannedOccurrence[] }[] = [
  {
    name: "a One-off Schedule has a single Occurrence with no Window end",
    input: {
      ...base,
      schedule: { kind: "one_off", dueDate: "2026-03-10" },
      referenceTime: new Date("2026-03-01T09:00:00Z"),
      horizon: new Date("2026-04-01T00:00:00Z"),
    },
    expected: [{ dueDate: "2026-03-10", windowEnd: null, timeSlot: null }],
  },
];

describe("Schedule engine", () => {
  for (const c of cases) {
    test(c.name, () => {
      expect(occurrencesUpTo(c.input)).toEqual(c.expected);
    });
  }
});

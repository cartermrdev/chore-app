/**
 * Schedule engine: pure and deterministic, no I/O, no clock.
 *
 * Given a Schedule definition, the Pauses that apply, the Household time
 * zone, the last Completion (for Interval Schedules) and a reference time, it
 * returns the Occurrences that should exist up to a horizon.
 *
 * Walking skeleton: only One-off Schedules so far. Fixed and Interval kinds,
 * Time Slots, Due Times, DST and Pause handling belong to the Schedule engine
 * ticket.
 */

/** A calendar date in the Household's time zone, "YYYY-MM-DD". */
export type LocalDate = string;

export type Schedule = { kind: "one_off"; dueDate: LocalDate };

export type Pause = { startDate: LocalDate; endDate: LocalDate | null };

export type ScheduleInput = {
  schedule: Schedule;
  timeZone: string;
  pauses: Pause[];
  lastCompletionAt: Date | null;
  referenceTime: Date;
  horizon: Date;
};

export type PlannedOccurrence = {
  dueDate: LocalDate;
  /** End of the Window; null for One-off Occurrences, which are never Missed. */
  windowEnd: Date | null;
  timeSlot: string | null;
};

export function occurrencesUpTo(input: ScheduleInput): PlannedOccurrence[] {
  switch (input.schedule.kind) {
    case "one_off":
      return [{ dueDate: input.schedule.dueDate, windowEnd: null, timeSlot: null }];
  }
}

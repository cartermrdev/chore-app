/**
 * Occurrence materialiser (ADR 0003: Occurrences are stored).
 *
 * Writes the Occurrences the Schedule engine says should exist by `now`
 * (every Occurrence whose Window has opened), and moves Fixed Occurrences
 * whose Window has closed without a Completion to Missed. Idempotent and
 * safe to run concurrently: it only ever adds rows the unique index allows.
 *
 * Schedule edits: the Chore's schedule is simply replaced, and planning
 * resumes where the latest stored Occurrence's Window ends (`resumeAfter`).
 * So an edit affects only Occurrences not yet created: stored ones (including
 * the current Open one and its Window) never change, and the new Schedule
 * cannot open an Occurrence inside the current Window.
 *
 * Runs lazily on reads and completions (`materialise`). A periodic sweep can
 * call the same function.
 */
import type { Db } from "../db/client";
import { occurrencesUpTo, type Schedule } from "../schedule/engine";

export type MaterialiseScope = {
  householdId: string;
  timeZone: string;
  now: Date;
  /** Limit to one Chore; otherwise every non-archived Chore in the Household. */
  choreId?: string;
};

export async function materialise(db: Db, scope: MaterialiseScope): Promise<void> {
  const { householdId, timeZone, now } = scope;
  const choreId = scope.choreId ?? null;

  const chores = await db`
    SELECT c.id, c.schedule, last.window_start AS last_start, last.window_end AS last_end
    FROM chores c
    LEFT JOIN LATERAL (
      SELECT o.window_start, o.window_end FROM occurrences o
      WHERE o.chore_id = c.id ORDER BY o.window_start DESC LIMIT 1
    ) last ON true
    WHERE c.household_id = ${householdId} AND c.archived_at IS NULL
      AND (${choreId}::uuid IS NULL OR c.id = ${choreId}::uuid)`;

  for (const chore of chores) {
    const planned = occurrencesUpTo({
      schedule: chore.schedule as Schedule,
      timeZone,
      pauses: [],
      lastCompletionAt: null,
      after: resumeAfter(chore.last_start ? { windowStart: chore.last_start, windowEnd: chore.last_end } : null),
      horizon: now,
    });
    if (planned.length === 0) continue;
    const rows = planned.map((p) => ({
      chore_id: chore.id,
      household_id: householdId,
      due_date: p.dueDate,
      time_slot: p.timeSlot,
      window_start: p.windowStart,
      due_time: p.dueTime,
      window_end: p.windowEnd,
      status: "open",
      created_at: now,
    }));
    await db`INSERT INTO occurrences ${db(rows)} ON CONFLICT DO NOTHING`;
  }

  // A Fixed Window that closed without a Completion: Missed.
  await db`
    UPDATE occurrences SET status = 'missed'
    WHERE household_id = ${householdId} AND status = 'open'
      AND window_end IS NOT NULL AND window_end <= ${now}
      AND (${choreId}::uuid IS NULL OR chore_id = ${choreId}::uuid)`;
}

export type StoredWindow = { windowStart: Date; windowEnd: Date | null };

/**
 * The `after` to plan new Occurrences from, given the latest stored one:
 * only Occurrences whose Window opens at or after its Window end (or, for a
 * One-off with no Window end, after its Window start). With an unedited
 * Schedule that is exactly the next planned Occurrence; after an edit it
 * keeps the new Schedule out of the current Window.
 */
export function resumeAfter(latest: StoredWindow | null): Date | null {
  if (!latest) return null;
  if (!latest.windowEnd) return latest.windowStart;
  return new Date(latest.windowEnd.getTime() - 1);
}

export type NextDue = { dueDate: string; dueTime: Date };

/**
 * When a Chore is next due: its earliest Open Occurrence if it has one,
 * otherwise the next Occurrence the Schedule will create after the latest
 * stored one (`latest`) (not stored yet, so Schedule edits still apply to it).
 */
export function deriveNextDue(
  schedule: Schedule,
  timeZone: string,
  firstOpen: { dueDate: string; dueTime: Date } | null,
  latest: StoredWindow | null,
): NextDue | null {
  if (firstOpen) return { dueDate: firstOpen.dueDate, dueTime: firstOpen.dueTime };
  const [next] = occurrencesUpTo({
    schedule,
    timeZone,
    pauses: [],
    lastCompletionAt: null,
    after: resumeAfter(latest),
    horizon: new Date("9999-12-31T00:00:00Z"),
    limit: 1,
  });
  return next ? { dueDate: next.dueDate, dueTime: next.dueTime } : null;
}

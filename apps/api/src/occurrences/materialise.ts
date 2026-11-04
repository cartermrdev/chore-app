/**
 * Occurrence materialiser (ADR 0003: Occurrences are stored).
 *
 * Writes the Occurrences the Schedule engine says should exist by `now`
 * (every Occurrence whose Window has opened), and moves Fixed Occurrences
 * whose Window has closed without a Completion to Missed. Idempotent and
 * safe to run concurrently: it only ever adds rows the unique index allows,
 * and only plans Occurrences after the latest stored one, so Schedule edits
 * affect only Occurrences not yet created.
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
    SELECT c.id, c.schedule, (SELECT max(o.window_start) FROM occurrences o WHERE o.chore_id = c.id) AS last_start
    FROM chores c
    WHERE c.household_id = ${householdId} AND c.archived_at IS NULL
      AND (${choreId}::uuid IS NULL OR c.id = ${choreId}::uuid)`;

  for (const chore of chores) {
    const planned = occurrencesUpTo({
      schedule: chore.schedule as Schedule,
      timeZone,
      pauses: [],
      lastCompletionAt: null,
      after: chore.last_start ?? null,
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

export type NextDue = { dueDate: string; dueTime: Date };

/**
 * When a Chore is next due: its earliest Open Occurrence if it has one,
 * otherwise the next Occurrence the Schedule will create after the latest
 * stored one (not stored yet, so Schedule edits still apply to it).
 */
export function deriveNextDue(
  schedule: Schedule,
  timeZone: string,
  firstOpen: { dueDate: string; dueTime: Date } | null,
  lastWindowStart: Date | null,
): NextDue | null {
  if (firstOpen) return { dueDate: firstOpen.dueDate, dueTime: firstOpen.dueTime };
  const [next] = occurrencesUpTo({
    schedule,
    timeZone,
    pauses: [],
    lastCompletionAt: null,
    after: lastWindowStart,
    horizon: new Date("9999-12-31T00:00:00Z"),
    limit: 1,
  });
  return next ? { dueDate: next.dueDate, dueTime: next.dueTime } : null;
}

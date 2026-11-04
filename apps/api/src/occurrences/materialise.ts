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
import { occurrencesUpTo, type PlannedOccurrence, type Schedule } from "../schedule/engine";

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
    SELECT c.id, c.schedule, c.assignee_id,
           last.window_start AS last_start, last.window_end AS last_end, last.closed_at AS last_closed
    FROM chores c
    -- The latest stored Occurrence; keep in step with loadLatestOccurrence below.
    LEFT JOIN LATERAL (
      SELECT o.window_start, o.window_end,
             COALESCE(cp.completed_at, o.excused_at, CASE WHEN o.status = 'missed' THEN o.window_end END) AS closed_at
      FROM occurrences o
      LEFT JOIN completions cp ON cp.occurrence_id = o.id AND cp.voided_at IS NULL
      WHERE o.chore_id = c.id
      ORDER BY o.window_start DESC LIMIT 1
    ) last ON true
    WHERE c.household_id = ${householdId} AND c.archived_at IS NULL
      AND (${choreId}::uuid IS NULL OR c.id = ${choreId}::uuid)`;

  let members: Set<string> | undefined;
  for (const chore of chores) {
    const planned = occurrencesUpTo({
      schedule: chore.schedule as Schedule,
      timeZone,
      pauses: [],
      lastCompletionAt: chore.last_closed ?? null,
      after: resumeAfter(chore.last_start ? { windowStart: chore.last_start, windowEnd: chore.last_end } : null),
      horizon: now,
    });
    if (planned.length === 0) continue;
    members ??= await currentMembers(db, householdId);
    await insertOccurrences(
      db,
      { chore: { id: chore.id, schedule: chore.schedule, assigneeId: chore.assignee_id }, householdId, now, members },
      planned,
    );
  }

  // A Fixed Window that closed without a Completion: Missed.
  await db`
    UPDATE occurrences SET status = 'missed'
    WHERE household_id = ${householdId} AND status = 'open'
      AND window_end IS NOT NULL AND window_end <= ${now}
      AND (${choreId}::uuid IS NULL OR chore_id = ${choreId}::uuid)`;
}

/**
 * Stores planned Occurrences as Open (skipping any that already exist),
 * copying each one's Assignee. The one place Occurrence rows are created:
 * the materialiser, and Early Completion, which creates the next Occurrence
 * ahead of its Window.
 */
export async function insertOccurrences(
  db: Db,
  scope: {
    chore: { id: string; schedule: Schedule; assigneeId: string | null };
    householdId: string;
    now: Date;
    /** Current Members of the Household, if the caller already has them. */
    members?: Set<string>;
  },
  planned: PlannedOccurrence[],
): Promise<void> {
  if (planned.length === 0) return;
  const { chore, householdId, now } = scope;
  const members = scope.members ?? (await currentMembers(db, householdId));
  const rows = planned.map((p) => {
    const assignee = assigneeFor(chore.schedule, chore.assigneeId, p.timeSlot);
    return {
      chore_id: chore.id,
      household_id: householdId,
      due_date: p.dueDate,
      time_slot: p.timeSlot,
      window_start: p.windowStart,
      due_time: p.dueTime,
      window_end: p.windowEnd,
      // An Assignee whose Membership has since ended is not copied.
      assignee_id: assignee && members.has(assignee) ? assignee : null,
      status: "open",
      created_at: now,
    };
  });
  await db`INSERT INTO occurrences ${db(rows)} ON CONFLICT DO NOTHING`;
}

/**
 * The Assignee to copy onto a new Occurrence: its Time Slot's when the
 * Schedule has slots (an unassigned slot stays unassigned), else the Chore's.
 */
export function assigneeFor(schedule: Schedule, choreAssigneeId: string | null, timeSlot: string | null): string | null {
  if (schedule.kind === "fixed" && schedule.slots?.length) {
    return schedule.slots.find((s) => s.name === timeSlot)?.assigneeId ?? null;
  }
  return choreAssigneeId;
}

async function currentMembers(db: Db, householdId: string): Promise<Set<string>> {
  const rows = await db`
    SELECT person_id FROM memberships WHERE household_id = ${householdId} AND ended_at IS NULL`;
  return new Set(rows.map((r: any) => r.person_id as string));
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

/** The next Occurrence: what a "Complete early" request names ({ dueDate, timeSlot }). */
export type NextDue = { dueDate: string; timeSlot: string | null; dueTime: Date };

/**
 * A Chore's latest stored Occurrence (where planning resumes), and when it
 * was closed: completed, Excused, or (its Window end) Missed. Null while it
 * is still Open. An Interval Schedule's next Occurrence counts from closedAt.
 */
export type LatestOccurrence = (StoredWindow & { closedAt: Date | null }) | null;

/** The Chore's LatestOccurrence; the same rule as the materialiser's lateral join. */
export async function loadLatestOccurrence(db: Db, choreId: string): Promise<LatestOccurrence> {
  const [r] = await db`
    SELECT o.window_start, o.window_end,
           COALESCE(cp.completed_at, o.excused_at, CASE WHEN o.status = 'missed' THEN o.window_end END) AS closed_at
    FROM occurrences o
    LEFT JOIN completions cp ON cp.occurrence_id = o.id AND cp.voided_at IS NULL
    WHERE o.chore_id = ${choreId}
    ORDER BY o.window_start DESC LIMIT 1`;
  return r ? { windowStart: r.window_start, windowEnd: r.window_end, closedAt: r.closed_at ?? null } : null;
}

/**
 * When a Chore is next due: its earliest Open Occurrence if it has one,
 * otherwise the next Occurrence the Schedule will create after the latest
 * stored one (`latest`) (not stored yet, so Schedule edits still apply to it).
 */
export function deriveNextDue(
  schedule: Schedule,
  timeZone: string,
  firstOpen: NextDue | null,
  latest: LatestOccurrence,
): NextDue | null {
  if (firstOpen) return { dueDate: firstOpen.dueDate, timeSlot: firstOpen.timeSlot, dueTime: firstOpen.dueTime };
  const next = planNext(schedule, timeZone, latest);
  return next ? { dueDate: next.dueDate, timeSlot: next.timeSlot, dueTime: next.dueTime } : null;
}

/** The next Occurrence the Schedule will create after the latest stored one, however far ahead. */
export function planNext(schedule: Schedule, timeZone: string, latest: LatestOccurrence): PlannedOccurrence | null {
  const [next] = occurrencesUpTo({
    schedule,
    timeZone,
    pauses: [],
    lastCompletionAt: latest?.closedAt ?? null,
    after: resumeAfter(latest),
    horizon: new Date("9999-12-31T00:00:00Z"),
    limit: 1,
  });
  return next ?? null;
}

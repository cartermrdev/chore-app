/**
 * Completion service: the single path that creates a Completion. Every
 * completion route (the Complete button, the Scan resolver, later Early and
 * "complete anyway") calls `completeDueOccurrence`.
 *
 * Guarantees:
 * - the Completer and Recorder have current Memberships in the Household,
 *   and a Recorder other than the Completer is an Admin;
 * - at most one active (non-voided) Completion per Occurrence, enforced by
 *   the partial unique index `completions_one_active_per_occurrence`, so a
 *   concurrent loser gets `already_completed` naming the winner;
 * - idempotency: the first result for (Recorder, idempotencyKey) is stored
 *   and returned verbatim for every repeat, which creates nothing new;
 * - Late is derived: completedAt after the Due Time (+30 min Grace Period
 *   for Time Slot Occurrences).
 *
 * Results are JSON-safe (ISO strings) because they are stored for replay.
 */
import type { Clock } from "../clock";
import type { Db } from "../db/client";
import { findMembership } from "../households/membership";
import { deriveNextDue, materialise } from "../occurrences/materialise";

export type Method = "manual" | "nfc";

export type CompleteRequest = {
  /** The Household the caller believes the Chore is in (from the route or the Tag). */
  householdId: string;
  choreId: string;
  completerId: string;
  recorderId: string;
  method: Method;
  /** Required for Method NFC, forbidden otherwise. */
  tagId?: string | null;
  idempotencyKey: string;
};

export type PersonRef = { id: string; displayName: string };

export type CompletionSummary = {
  id: string;
  occurrenceId: string;
  choreId: string;
  choreName: string;
  dueDate: string;
  timeSlot: string | null;
  completer: PersonRef;
  recorder: PersonRef;
  /** The Occurrence's Assignee (who was expected to do it), which may differ from the Completer. */
  assignee: PersonRef | null;
  method: Method;
  tagId: string | null;
  completedAt: string;
  late: boolean;
};

export type NextDueJson = { dueDate: string; dueTime: string } | null;

export type CompleteResult =
  /** A new Completion was recorded. */
  | { outcome: "completed"; completion: CompletionSummary; nextDue: NextDueJson }
  /** The currently due Occurrence already has a Completion (possibly by a concurrent request). */
  | { outcome: "already_completed"; completion: CompletionSummary; nextDue: NextDueJson }
  /** No Occurrence is due now and the current one (if any) was not completed. */
  | { outcome: "nothing_due"; nextDue: NextDueJson }
  /** Completer or Recorder lacks a current Membership, or a non-Admin recorded for someone else. */
  | { outcome: "not_a_member" }
  | { outcome: "forbidden" }
  /** No such non-archived Chore in that Household. */
  | { outcome: "chore_not_found" };

/** Grace Period for Time Slot Occurrences (day-level Occurrences have none). */
export const GRACE_PERIOD_MS = 30 * 60_000;

export function isLate(completedAt: Date, occ: { dueTime: Date; timeSlot: string | null }): boolean {
  const grace = occ.timeSlot ? GRACE_PERIOD_MS : 0;
  return completedAt.getTime() > occ.dueTime.getTime() + grace;
}

/** Completes the Chore's earliest Open Occurrence whose Window is open now. */
export async function completeDueOccurrence(
  deps: { db: Db; clock: Clock },
  req: CompleteRequest,
): Promise<CompleteResult> {
  const { db, clock } = deps;
  if ((req.method === "nfc") !== Boolean(req.tagId)) throw new Error("tagId is required for, and only for, Method NFC");

  const [completer, recorder] = await Promise.all([
    findMembership(db, req.householdId, req.completerId),
    findMembership(db, req.householdId, req.recorderId),
  ]);
  if (!completer || !recorder) return { outcome: "not_a_member" };
  if (req.completerId !== req.recorderId && recorder.role !== "admin") return { outcome: "forbidden" };

  const [chore] = await db`
    SELECT id, name, schedule FROM chores
    WHERE id = ${req.choreId}::uuid AND household_id = ${req.householdId} AND archived_at IS NULL`.catch(() => []);
  if (!chore) return { outcome: "chore_not_found" };

  const now = clock.now();
  await materialise(db, { householdId: req.householdId, timeZone: completer.timeZone, now, choreId: chore.id });

  return db.begin(async (tx) => {
    const claimed = await tx`
      INSERT INTO completion_requests (recorder_id, idempotency_key, result, created_at)
      VALUES (${req.recorderId}, ${req.idempotencyKey}, NULL, ${now})
      ON CONFLICT DO NOTHING
      RETURNING 1`;
    if (claimed.length === 0) {
      // A repeat: the original committed before our insert returned (it waits on the key).
      const [stored] = await tx`
        SELECT result FROM completion_requests
        WHERE recorder_id = ${req.recorderId} AND idempotency_key = ${req.idempotencyKey}`;
      return stored.result as CompleteResult;
    }

    const result = await completeInTx(tx, chore, completer.timeZone, req, now);
    await tx`
      UPDATE completion_requests SET result = ${result}
      WHERE recorder_id = ${req.recorderId} AND idempotency_key = ${req.idempotencyKey}`;
    return result;
  });
}

async function completeInTx(
  tx: Db,
  chore: { id: string; name: string; schedule: any },
  timeZone: string,
  req: CompleteRequest,
  now: Date,
): Promise<CompleteResult> {
  const [target] = await tx`
    SELECT id, due_time, time_slot FROM occurrences
    WHERE chore_id = ${chore.id} AND status = 'open' AND window_start <= ${now}
      AND (window_end IS NULL OR window_end > ${now})
    ORDER BY window_start LIMIT 1`;

  if (target) {
    const late = isLate(now, { dueTime: target.due_time, timeSlot: target.time_slot });
    const inserted = await tx`
      INSERT INTO completions
        (occurrence_id, household_id, completer_id, recorder_id, method, tag_id, completed_at, late)
      VALUES (${target.id}, ${req.householdId}, ${req.completerId}, ${req.recorderId}, ${req.method},
              ${req.tagId ?? null}, ${now}, ${late})
      ON CONFLICT (occurrence_id) WHERE voided_at IS NULL DO NOTHING
      RETURNING id`;
    if (inserted.length > 0) {
      await tx`UPDATE occurrences SET status = 'completed' WHERE id = ${target.id}`;
      return {
        outcome: "completed",
        completion: (await loadSummary(tx, { completionId: inserted[0].id }))!,
        nextDue: await nextDueJson(tx, chore, timeZone),
      };
    }
    // Lost a race: a concurrent request completed this Occurrence first.
    return {
      outcome: "already_completed",
      completion: (await loadSummary(tx, { occurrenceId: target.id }))!,
      nextDue: await nextDueJson(tx, chore, timeZone),
    };
  }

  // Nothing Open is due: report the current Occurrence's Completion if it has one.
  const [current] = await tx`
    SELECT id FROM occurrences
    WHERE chore_id = ${chore.id} AND window_start <= ${now}
    ORDER BY window_start DESC LIMIT 1`;
  const existing = current ? await loadSummary(tx, { occurrenceId: current.id }) : null;
  const nextDue = await nextDueJson(tx, chore, timeZone);
  if (existing) return { outcome: "already_completed", completion: existing, nextDue };
  return { outcome: "nothing_due", nextDue };
}

async function nextDueJson(tx: Db, chore: { id: string; schedule: any }, timeZone: string): Promise<NextDueJson> {
  const [firstOpen] = await tx`
    SELECT due_date::text AS due_date, due_time FROM occurrences
    WHERE chore_id = ${chore.id} AND status = 'open' ORDER BY window_start LIMIT 1`;
  const [last] = await tx`
    SELECT window_start, window_end FROM occurrences
    WHERE chore_id = ${chore.id} ORDER BY window_start DESC LIMIT 1`;
  const next = deriveNextDue(
    chore.schedule,
    timeZone,
    firstOpen ? { dueDate: firstOpen.due_date, dueTime: firstOpen.due_time } : null,
    last ? { windowStart: last.window_start, windowEnd: last.window_end } : null,
  );
  return next ? { dueDate: next.dueDate, dueTime: next.dueTime.toISOString() } : null;
}

/** The active Completion by id or by Occurrence. */
async function loadSummary(
  tx: Db,
  by: { completionId: string } | { occurrenceId: string },
): Promise<CompletionSummary | null> {
  const completionId = "completionId" in by ? by.completionId : null;
  const occurrenceId = "occurrenceId" in by ? by.occurrenceId : null;
  const [r] = await tx`
    SELECT c.id, c.occurrence_id, o.chore_id, ch.name AS chore_name, o.due_date::text AS due_date, o.time_slot,
           cp.id AS completer_id, cp.display_name AS completer_name,
           rp.id AS recorder_id, rp.display_name AS recorder_name,
           ap.id AS assignee_id, ap.display_name AS assignee_name,
           c.method, c.tag_id, c.completed_at, c.late
    FROM completions c
    JOIN occurrences o ON o.id = c.occurrence_id
    JOIN chores ch ON ch.id = o.chore_id
    JOIN persons cp ON cp.id = c.completer_id
    JOIN persons rp ON rp.id = c.recorder_id
    LEFT JOIN persons ap ON ap.id = o.assignee_id
    WHERE c.voided_at IS NULL
      AND (${completionId}::uuid IS NULL OR c.id = ${completionId}::uuid)
      AND (${occurrenceId}::uuid IS NULL OR c.occurrence_id = ${occurrenceId}::uuid)
    LIMIT 1`;
  if (!r) return null;
  return {
    id: r.id,
    occurrenceId: r.occurrence_id,
    choreId: r.chore_id,
    choreName: r.chore_name,
    dueDate: r.due_date,
    timeSlot: r.time_slot,
    completer: { id: r.completer_id, displayName: r.completer_name },
    recorder: { id: r.recorder_id, displayName: r.recorder_name },
    assignee: r.assignee_id ? { id: r.assignee_id, displayName: r.assignee_name } : null,
    method: r.method,
    tagId: r.tag_id,
    completedAt: new Date(r.completed_at).toISOString(),
    late: r.late,
  };
}

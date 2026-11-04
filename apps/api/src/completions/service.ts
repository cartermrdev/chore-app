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
import { findMembership } from "../households/access";
import { isLocalDate } from "../schedule/calendar";
import { loadChorePauses } from "../pauses/service";
import {
  deriveNextDue,
  insertOccurrences,
  materialise,
  planEarlyTarget,
  deriveEarlyTarget,
  planThrough,
  applyPauses,
  loadLatestOccurrence,
} from "../occurrences/materialise";

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
  /** An Early Completion: recorded before the Occurrence was due (only via `completeEarly`). */
  early: boolean;
};

/** The next Occurrence; `{ dueDate, timeSlot }` is what a "Complete early" request names. */
export type NextDueJson = { dueDate: string; timeSlot: string | null; dueTime: string } | null;

export type CompleteResult =
  /** A new Completion was recorded. */
  | { outcome: "completed"; completion: CompletionSummary; nextDue: NextDueJson }
  /** The currently due Occurrence already has a Completion (possibly by a concurrent request). */
  | { outcome: "already_completed"; completion: CompletionSummary; nextDue: NextDueJson }
  /** No Occurrence is due now and the current one (if any) was not completed. */
  | { outcome: "nothing_due"; nextDue: NextDueJson }
  /** The Recorder lacks a current Membership in the Household. */
  | { outcome: "not_a_member" }
  /** A Completer other than the Recorder lacks a current Membership there. */
  | { outcome: "completer_not_in_household" }
  /** A non-Admin recorded for someone else. */
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
export function completeDueOccurrence(deps: { db: Db; clock: Clock }, req: CompleteRequest): Promise<CompleteResult> {
  return runCompletion(deps, req, req.idempotencyKey, (c) => completeInTx(c.tx, c.chore, c.timeZone, req, c.now));
}

export type EarlyRequest = CompleteRequest & {
  /** The Occurrence the Person means to complete: the next one, as they last saw it (`nextDue`). */
  dueDate: string;
  timeSlot?: string | null;
};

/**
 * Records an Early Completion: completes the Chore's next Occurrence even
 * though it is not yet due (creating it ahead of its Window if necessary).
 * Always a separate, explicit request; a Scan never implies it. If the next
 * Occurrence is already due, it is completed as normal (`early: false`).
 *
 * The request names the Occurrence it means, so two people pressing
 * "Complete early" at once produce one Completion: the loser, or anyone
 * naming an Occurrence that is no longer the next, gets `already_completed`
 * (that Occurrence has a Completion) or `nothing_due` (stale; see nextDue).
 */
export function completeEarly(deps: { db: Db; clock: Clock }, req: EarlyRequest): Promise<CompleteResult> {
  // Separate key space so an early request never replays a plain completion's stored result.
  return runCompletion(deps, req, `early:${req.idempotencyKey}`, (c) => completeEarlyInTx(c, req));
}

/** The client-generated idempotency key from an untrusted request body; null if missing or malformed. */
export function idempotencyKeyOf(body: any): string | null {
  const key = body?.idempotencyKey;
  return typeof key === "string" && key.length >= 1 && key.length <= 200 ? key : null;
}

/** Validates the Occurrence an untrusted early request names; null if invalid. */
export function parseEarlyTarget(body: any): { dueDate: string; timeSlot: string | null } | null {
  if (!isLocalDate(body?.dueDate)) return null;
  const timeSlot = body.timeSlot ?? null;
  if (timeSlot !== null && (typeof timeSlot !== "string" || timeSlot.length > 100)) return null;
  return { dueDate: body.dueDate, timeSlot };
}

type ChoreRow = { id: string; name: string; schedule: any; assignee_id: string | null; household_id: string };
type InTx = { tx: Db; chore: ChoreRow; timeZone: string; now: Date };

/** The checks, materialisation and idempotency every completion entry point shares. */
async function runCompletion(
  deps: { db: Db; clock: Clock },
  req: CompleteRequest,
  idempotencyKey: string,
  work: (c: InTx) => Promise<CompleteResult>,
): Promise<CompleteResult> {
  const { db, clock } = deps;
  if ((req.method === "nfc") !== Boolean(req.tagId)) throw new Error("tagId is required for, and only for, Method NFC");

  const [completer, recorder] = await Promise.all([
    findMembership(db, req.householdId, req.completerId),
    findMembership(db, req.householdId, req.recorderId),
  ]);
  if (!recorder) return { outcome: "not_a_member" };
  if (!completer) return { outcome: "completer_not_in_household" };
  if (req.completerId !== req.recorderId && recorder.role !== "admin") return { outcome: "forbidden" };

  const [chore] = await db`
    SELECT id, name, schedule, assignee_id, household_id FROM chores
    WHERE id = ${req.choreId}::uuid AND household_id = ${req.householdId} AND archived_at IS NULL`.catch(() => []);
  if (!chore) return { outcome: "chore_not_found" };

  const now = clock.now();
  await materialise(db, { householdId: req.householdId, timeZone: completer.timeZone, now, choreId: chore.id });

  return db.begin(async (tx) => {
    const claimed = await tx`
      INSERT INTO completion_requests (recorder_id, idempotency_key, result, created_at)
      VALUES (${req.recorderId}, ${idempotencyKey}, NULL, ${now})
      ON CONFLICT DO NOTHING
      RETURNING 1`;
    if (claimed.length === 0) {
      // A repeat: the original committed before our insert returned (it waits on the key).
      const [stored] = await tx`
        SELECT result FROM completion_requests
        WHERE recorder_id = ${req.recorderId} AND idempotency_key = ${idempotencyKey}`;
      return stored.result as CompleteResult;
    }

    const result = await work({ tx, chore, timeZone: completer.timeZone, now });
    await tx`
      UPDATE completion_requests SET result = ${result}
      WHERE recorder_id = ${req.recorderId} AND idempotency_key = ${idempotencyKey}`;
    return result;
  });
}

type Target = { id: string; windowStart: Date; dueTime: Date; timeSlot: string | null };

/**
 * Records the Completion on the target Occurrence, or reports the one a
 * concurrent request got in first (the partial unique index decides).
 */
async function completeTarget({ tx, chore, timeZone, now }: InTx, req: CompleteRequest, target: Target): Promise<CompleteResult> {
  const late = isLate(now, target);
  const early = now < target.windowStart;
  const inserted = await tx`
    INSERT INTO completions
      (occurrence_id, household_id, completer_id, recorder_id, method, tag_id, completed_at, late, early)
    VALUES (${target.id}, ${req.householdId}, ${req.completerId}, ${req.recorderId}, ${req.method},
            ${req.tagId ?? null}, ${now}, ${late}, ${early})
    ON CONFLICT (occurrence_id) WHERE voided_at IS NULL DO NOTHING
    RETURNING id`;
  if (inserted.length > 0) {
    // An Early Completion under an indefinite Pause may land on a Pause-Skipped Occurrence; it is completed now.
    await tx`UPDATE occurrences SET status = 'completed', skipped_by_pause_id = NULL WHERE id = ${target.id}`;
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

async function completeEarlyInTx(c: InTx, req: EarlyRequest): Promise<CompleteResult> {
  const { tx, chore, timeZone, now } = c;
  const timeSlot = req.timeSlot ?? null;

  // The next Occurrence: the earliest stored one still completable, else the one the Schedule creates next.
  const [open] = await tx`
    SELECT id, due_date::text AS due_date, time_slot, window_start, due_time FROM occurrences
    WHERE chore_id = ${chore.id} AND status = 'open' AND (window_end IS NULL OR window_end > ${now})
    ORDER BY window_start LIMIT 1`;
  // Fixed Occurrences inside a Pause are not "next" (they'll be Skipped); an Interval one moves to the Pause's end.
  // Under an indefinite Pause, the next one ignoring the Pause ("Complete anyway"; see planEarlyTarget).
  const pauses = await loadChorePauses(tx, req.householdId, chore.id);
  const latest = open ? null : await loadLatestOccurrence(tx, chore.id);
  const planned = open ? null : planEarlyTarget(chore.schedule, timeZone, latest, pauses);
  const candidate: (Omit<Target, "id"> & { id: string | null; dueDate: string }) | null = open
    ? { id: open.id, dueDate: open.due_date, timeSlot: open.time_slot, windowStart: open.window_start, dueTime: open.due_time }
    : planned && { id: null, ...planned.next };

  if (!candidate || candidate.dueDate !== req.dueDate || candidate.timeSlot !== timeSlot) {
    // Not the next Occurrence: completed already (perhaps by a concurrent request), or a stale request.
    const [asked] = await tx`
      SELECT id FROM occurrences
      WHERE chore_id = ${chore.id} AND due_date = ${req.dueDate}::date AND COALESCE(time_slot, '') = ${timeSlot ?? ""}`.catch(() => []);
    const existing = asked ? await loadSummary(tx, { occurrenceId: asked.id }) : null;
    const nextDue = await nextDueJson(tx, chore, timeZone);
    return existing ? { outcome: "already_completed", completion: existing, nextDue } : { outcome: "nothing_due", nextDue };
  }

  let id = candidate.id;
  if (!id) {
    // Create it ahead of its Window, together with any Pause-covered Fixed Occurrences before it
    // (stored as Skipped, so history has no gap and planning resumes after the target).
    // A concurrent request may have just done so; then we use that row.
    const choreToPlan = { id: chore.id, schedule: chore.schedule, assigneeId: chore.assignee_id };
    const upToTarget = planThrough(chore.schedule, timeZone, latest, planned!.pauses, planned!.next.windowStart);
    await insertOccurrences(tx, { chore: choreToPlan, householdId: req.householdId, now }, upToTarget);
    await applyPauses(tx, { householdId: req.householdId, now, choreId: chore.id });
    const [row] = await tx`
      SELECT id FROM occurrences
      WHERE chore_id = ${chore.id} AND due_date = ${candidate.dueDate}::date AND COALESCE(time_slot, '') = ${timeSlot ?? ""}`;
    id = row.id as string;
  }
  return completeTarget(c, req, { id, windowStart: candidate.windowStart, dueTime: candidate.dueTime, timeSlot });
}

async function completeInTx(
  tx: Db,
  chore: ChoreRow,
  timeZone: string,
  req: CompleteRequest,
  now: Date,
): Promise<CompleteResult> {
  const [target] = await tx`
    SELECT id, window_start, due_time, time_slot FROM occurrences
    WHERE chore_id = ${chore.id} AND status = 'open' AND window_start <= ${now}
      AND (window_end IS NULL OR window_end > ${now})
    ORDER BY window_start LIMIT 1`;

  if (target) {
    return completeTarget({ tx, chore, timeZone, now }, req, {
      id: target.id,
      windowStart: target.window_start,
      dueTime: target.due_time,
      timeSlot: target.time_slot,
    });
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

/**
 * The Occurrence "Complete anyway" would record on (materialising first),
 * without completing anything: what the Scan resolver's `paused` outcome
 * offers. The next that will fall due, or under an indefinite Pause the next
 * one ignoring the Pause (see planEarlyTarget). Null for an unknown or
 * Archived Chore, or when the Schedule has nothing next.
 */
export async function completeAnywayTarget(
  deps: { db: Db; clock: Clock },
  input: { householdId: string; choreId: string; timeZone: string },
): Promise<NextDueJson> {
  const { db, clock } = deps;
  const [chore] = await db`
    SELECT id, schedule, household_id FROM chores
    WHERE id = ${input.choreId}::uuid AND household_id = ${input.householdId} AND archived_at IS NULL`.catch(() => []);
  if (!chore) return null;
  await materialise(db, { householdId: input.householdId, timeZone: input.timeZone, now: clock.now(), choreId: chore.id });
  return nextDueJson(db, chore, input.timeZone, deriveEarlyTarget);
}

async function nextDueJson(
  tx: Db,
  chore: { id: string; schedule: any; household_id: string },
  timeZone: string,
  derive: typeof deriveNextDue = deriveNextDue,
): Promise<NextDueJson> {
  const [firstOpen] = await tx`
    SELECT due_date::text AS due_date, time_slot, due_time FROM occurrences
    WHERE chore_id = ${chore.id} AND status = 'open' ORDER BY window_start LIMIT 1`;
  const next = derive(
    chore.schedule,
    timeZone,
    firstOpen ? { dueDate: firstOpen.due_date, timeSlot: firstOpen.time_slot, dueTime: firstOpen.due_time } : null,
    await loadLatestOccurrence(tx, chore.id),
    await loadChorePauses(tx, chore.household_id, chore.id),
  );
  return next ? { dueDate: next.dueDate, timeSlot: next.timeSlot, dueTime: next.dueTime.toISOString() } : null;
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
           c.method, c.tag_id, c.completed_at, c.late, c.early
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
    early: r.early,
  };
}

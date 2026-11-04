/**
 * Scan resolver: turns a Scan (a Person opening /nfc/{tagId}) into exactly
 * one of the spec's eight outcomes. It finds the Household from the Tag (ADR
 * 0002) and completes through the Completion service, never directly.
 *
 * The Tag ID must be well-formed (the route answers 404 for a malformed one,
 * which cannot be a Tag at all). The checks run in order, each returning early:
 *   0. no session               -> unauthenticated
 *   1. unknown Tag              -> tag_unregistered
 *   2. no current Membership    -> not_a_member (names nothing)
 *   3. no (non-archived) Chore  -> tag_unlinked
 *   4. Chore paused today       -> paused (Scan only; records nothing)
 *   5. Completion service       -> completed | already_completed | nothing_due
 * Early and "Complete anyway" completions are separate explicit requests
 * (`resolveEarlyScan`), never implied by a scan: a scan with nothing due only
 * offers one (`earlyCompletionOffered`), and a paused one offers "Complete
 * anyway" (`completeAnywayOffered`), which is an Early Completion of `nextDue`.
 */
import type { Clock } from "../clock";
import type { Db } from "../db/client";
import {
  completeDueOccurrence,
  completeEarly,
  completeAnywayTarget,
  type CompleteRequest,
  type CompleteResult,
  type CompletionSummary,
  type NextDueJson,
} from "../completions/service";
import { undoRemainingMs } from "../completions/corrections";
import { findMembership } from "../households/access";
import { findTag } from "../tags/service";
import { pausedUntil } from "../pauses/service";

export type ScanRequest = {
  /** A well-formed Tag ID (see tags/service `isWellFormedTagId`). */
  tagId: string;
  /** The signed-in Person, both Completer and Recorder; null without a session. */
  personId: string | null;
  /** Client-generated, stable across retries of the same Scan. */
  idempotencyKey: string;
};

export type ChoreRef = { id: string; name: string };

export type ScanOutcome =
  /** `undoRemainingMs`: how long the Completer can still Undo, by the server's clock at response time. */
  | { outcome: "completed"; chore: ChoreRef; completion: CompletionSummary; nextDue: NextDueJson; undoRemainingMs: number }
  | {
      outcome: "already_completed";
      chore: ChoreRef;
      completion: CompletionSummary;
      nextDue: NextDueJson;
      earlyCompletionOffered: boolean;
    }
  | { outcome: "nothing_due"; chore: ChoreRef; nextDue: NextDueJson; earlyCompletionOffered: boolean }
  /**
   * A Chore or Household Pause covers today. `until` is the last paused date
   * (null: indefinite); `nextDue` is the Occurrence "Complete anyway" (POST
   * /api/scan/:tagId/complete-early) names: the next that will fall due, or
   * under an indefinite Pause the next one ignoring the Pause.
   */
  | {
      outcome: "paused";
      chore: ChoreRef;
      until: string | null;
      nextDue: NextDueJson;
      completeAnywayOffered: boolean;
    }
  /** The Tag points at no Chore, or at an Archived one. */
  | { outcome: "tag_unlinked"; householdId: string; canLink: boolean }
  /** The Person has no current Membership in the Tag's Household. Reveals nothing about it. */
  | { outcome: "not_a_member" }
  /**
   * A well-formed Tag ID the system has never seen (an Unregistered Tag).
   * `households` lists the Households the viewer is an Admin of, which they
   * may claim it for; `canClaim` is true when there is at least one.
   */
  | { outcome: "tag_unregistered"; canClaim: boolean; households: HouseholdRef[] }
  /** No session: sign in, then the scan page resends the same request. */
  | { outcome: "unauthenticated" };

export type HouseholdRef = { id: string; name: string };

export function resolveScan(deps: { db: Db; clock: Clock }, req: ScanRequest): Promise<ScanOutcome> {
  return resolveTag(deps, req, (request) => completeDueOccurrence(deps, request), { checkPause: true });
}

/** The Occurrence the Person means to complete early: the `nextDue` the scan screen showed. */
export type EarlyScanRequest = ScanRequest & { dueDate: string; timeSlot: string | null };

/**
 * "Complete early" on the scan screen: a separate, explicit request after a
 * Scan found nothing due. Same Tag checks and outcomes as a Scan; records an
 * Early Completion (Method NFC, this Tag) through the Completion service.
 */
export function resolveEarlyScan(deps: { db: Db; clock: Clock }, req: EarlyScanRequest): Promise<ScanOutcome> {
  // No Pause check: on a paused Chore this is "Complete anyway".
  return resolveTag(
    deps,
    req,
    (request) => completeEarly(deps, { ...request, dueDate: req.dueDate, timeSlot: req.timeSlot }),
    { checkPause: false },
  );
}

async function resolveTag(
  deps: { db: Db; clock: Clock },
  req: ScanRequest,
  complete: (request: CompleteRequest) => Promise<CompleteResult>,
  opts: { checkPause: boolean },
): Promise<ScanOutcome> {
  const { personId } = req;
  if (!personId) return { outcome: "unauthenticated" };

  const tag = await findTag(deps.db, req.tagId);
  if (!tag) {
    const households = await adminHouseholds(deps.db, personId);
    return { outcome: "tag_unregistered", canClaim: households.length > 0, households };
  }

  const membership = await findMembership(deps.db, tag.householdId, personId);
  if (!membership) return { outcome: "not_a_member" };

  const unlinked = { outcome: "tag_unlinked", householdId: tag.householdId, canLink: membership.role === "admin" } as const;
  if (!tag.chore) return unlinked;

  if (opts.checkPause) {
    const scope = { householdId: tag.householdId, choreId: tag.chore.id, timeZone: membership.timeZone };
    const until = await pausedUntil(deps.db, { ...scope, now: deps.clock.now() });
    if (until !== undefined) {
      const nextDue = await completeAnywayTarget(deps, scope);
      return { outcome: "paused", chore: tag.chore, until, nextDue, completeAnywayOffered: nextDue !== null };
    }
  }

  const result = await complete({
    householdId: tag.householdId,
    choreId: tag.chore.id,
    completerId: personId,
    recorderId: personId,
    method: "nfc",
    tagId: tag.id,
    idempotencyKey: scanKey(req),
  });
  const chore = tag.chore;
  // Nothing to do now: offer "Complete early" whenever there is a next Occurrence to complete.
  const earlyCompletionOffered = "nextDue" in result && result.nextDue !== null;
  switch (result.outcome) {
    case "completed":
      return {
        outcome: "completed",
        chore,
        completion: result.completion,
        nextDue: result.nextDue,
        // Computed per response, not stored with the result, so a replayed retry counts down correctly.
        undoRemainingMs: undoRemainingMs(result.completion.completedAt, deps.clock.now()),
      };
    case "already_completed":
      return { outcome: "already_completed", chore, completion: result.completion, nextDue: result.nextDue, earlyCompletionOffered };
    case "nothing_due":
      return { outcome: "nothing_due", chore, nextDue: result.nextDue, earlyCompletionOffered };
    case "chore_not_found":
      return unlinked; // archived or removed between the Tag lookup and the completion
    case "not_a_member": // the Membership ended between our check and the completion
    case "completer_not_in_household": // cannot happen: Completer = Recorder
    case "forbidden": // cannot happen: Completer = Recorder
      return { outcome: "not_a_member" };
  }
}

/** Households in which the Person currently holds the Admin Role. */
async function adminHouseholds(db: Db, personId: string): Promise<HouseholdRef[]> {
  const rows = await db`
    SELECT h.id, h.name FROM memberships m JOIN households h ON h.id = m.household_id
    WHERE m.person_id = ${personId} AND m.role = 'admin' AND m.ended_at IS NULL
    ORDER BY h.name, h.id`;
  return rows.map((r: any) => ({ id: r.id, name: r.name }));
}

/**
 * Idempotency keys are scoped per Household and Recorder by the Completion service. Prefix
 * scan keys so a scan can never replay a Manual request's stored result.
 */
function scanKey(req: Pick<ScanRequest, "tagId" | "idempotencyKey">): string {
  return `scan:${req.tagId}:${req.idempotencyKey}`;
}

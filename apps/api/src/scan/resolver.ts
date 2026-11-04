/**
 * Scan resolver: turns a Scan (a Person opening /nfc/{tagId}) into exactly
 * one outcome. It finds the Household from the Tag (ADR 0002) and completes
 * through the Completion service, never directly.
 *
 * The checks run in order, each returning early:
 *   1. unknown Tag              -> tag_unregistered (well-formed id) | tag_not_found (malformed)
 *   2. no current Membership    -> not_a_member (names nothing)
 *   3. no (non-archived) Chore  -> tag_unlinked
 *   4. Completion service       -> completed | already_completed | nothing_due
 * New outcomes (paused, tag_unregistered, unauthenticated) slot in as extra
 * steps and union members. Early and "complete anyway" completions are
 * separate explicit requests (a future `intent`), never implied by a scan.
 */
import type { Clock } from "../clock";
import type { Db } from "../db/client";
import {
  completeDueOccurrence,
  type CompletionSummary,
  type NextDueJson,
} from "../completions/service";
import { findMembership } from "../households/membership";
import { findTag, isWellFormedTagId } from "../tags/service";

export type ScanRequest = {
  tagId: string;
  /** The signed-in Person: both Completer and Recorder. */
  personId: string;
  /** Client-generated, stable across retries of the same Scan. */
  idempotencyKey: string;
};

export type ChoreRef = { id: string; name: string };

export type ScanOutcome =
  | { outcome: "completed"; chore: ChoreRef; completion: CompletionSummary; nextDue: NextDueJson }
  | { outcome: "already_completed"; chore: ChoreRef; completion: CompletionSummary; nextDue: NextDueJson }
  | { outcome: "nothing_due"; chore: ChoreRef; nextDue: NextDueJson; earlyCompletionOffered: boolean }
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
  /** The id is malformed, so it cannot be a Tag at all (the route returns 404). */
  | { outcome: "tag_not_found" };

export type HouseholdRef = { id: string; name: string };

export async function resolveScan(deps: { db: Db; clock: Clock }, req: ScanRequest): Promise<ScanOutcome> {
  const tag = await findTag(deps.db, req.tagId);
  if (!tag) {
    if (!isWellFormedTagId(req.tagId)) return { outcome: "tag_not_found" };
    const households = await adminHouseholds(deps.db, req.personId);
    return { outcome: "tag_unregistered", canClaim: households.length > 0, households };
  }

  const membership = await findMembership(deps.db, tag.householdId, req.personId);
  if (!membership) return { outcome: "not_a_member" };

  const unlinked = { outcome: "tag_unlinked", householdId: tag.householdId, canLink: membership.role === "admin" } as const;
  if (!tag.chore) return unlinked;

  const result = await completeDueOccurrence(deps, {
    householdId: tag.householdId,
    choreId: tag.chore.id,
    completerId: req.personId,
    recorderId: req.personId,
    method: "nfc",
    tagId: tag.id,
    idempotencyKey: scanKey(req),
  });
  const chore = tag.chore;
  switch (result.outcome) {
    case "completed":
    case "already_completed":
      return { outcome: result.outcome, chore, completion: result.completion, nextDue: result.nextDue };
    case "nothing_due":
      return { outcome: "nothing_due", chore, nextDue: result.nextDue, earlyCompletionOffered: false };
    case "chore_not_found":
      return unlinked; // archived or removed between the Tag lookup and the completion
    case "not_a_member":
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
 * Idempotency keys are scoped per Recorder by the Completion service. Prefix
 * scan keys so a scan can never replay a Manual request's stored result.
 */
function scanKey(req: ScanRequest): string {
  return `scan:${req.tagId}:${req.idempotencyKey}`;
}

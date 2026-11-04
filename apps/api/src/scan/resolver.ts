/**
 * Scan resolver: turns a Scan (a Person opening /nfc/{tagId}) into exactly
 * one outcome. It finds the Household from the Tag (ADR 0002) and completes
 * through the Completion service, never directly.
 *
 * The checks run in order, each returning early:
 *   1. unknown Tag              -> tag_not_found (to become tag_unregistered)
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
import { findTag } from "../tags/service";

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
  /** No Tag has this id. */
  | { outcome: "tag_not_found" };

export async function resolveScan(deps: { db: Db; clock: Clock }, req: ScanRequest): Promise<ScanOutcome> {
  const tag = await findTag(deps.db, req.tagId);
  if (!tag) return { outcome: "tag_not_found" };

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

/**
 * Idempotency keys are scoped per Recorder by the Completion service. Prefix
 * scan keys so a scan can never replay a Manual request's stored result.
 */
function scanKey(req: ScanRequest): string {
  return `scan:${req.tagId}:${req.idempotencyKey}`;
}

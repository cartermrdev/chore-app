/**
 * Corrections: Undo, Void and Excuse. None of these creates a Completion
 * (that stays the Completion service's job); they withdraw one or move an
 * Occurrence to Skipped.
 *
 * - Undo: the Completer withdraws their own Completion within UNDO_WINDOW_MS.
 * - Void: an Admin cancels any Completion, at any time.
 *   Both keep the record (voided_at, voided_by) and put the Occurrence back
 *   to Open if its Window is still open, otherwise Missed (ADR 0003). The
 *   partial unique index then allows a new Completion.
 * - Excuse: an Admin moves an Open or Missed Occurrence to Skipped with a
 *   note, recording who excused it and when.
 *
 * Every lookup finds the Household from the record and requires the caller
 * to have a current Membership there; outsiders get `not_found`.
 */
import type { Clock } from "../clock";
import type { Db } from "../db/client";
import { findMembership } from "../households/access";

/** How long the Completer can Undo their own Completion. */
export const UNDO_WINDOW_MS = 5 * 60_000;

/**
 * How much of the Undo window is left at `now` (0 once it has passed). Sent
 * to the app so it hides Undo by the server's clock, not the phone's.
 */
export function undoRemainingMs(completedAt: Date | string, now: Date): number {
  return Math.max(0, new Date(completedAt).getTime() + UNDO_WINDOW_MS - now.getTime());
}

export const EXCUSE_NOTE_MAX = 500;

type Deps = { db: Db; clock: Clock };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WithdrawResult =
  | { ok: true; occurrence: { id: string; status: "open" | "missed" } }
  | { ok: false; error: "not_found" | "forbidden" | "undo_expired" | "already_voided" };

export type ExcuseResult =
  | { ok: true; occurrence: { id: string; status: "skipped" } }
  | { ok: false; error: "not_found" | "forbidden" | "not_excusable" | "note_required" };

/** Undo: only the Completer, only within UNDO_WINDOW_MS of the Completion. */
export function undoCompletion(deps: Deps, req: { completionId: string; personId: string }): Promise<WithdrawResult> {
  return withdraw(deps, req, "undo");
}

/** Void: Admins only, at any time. */
export function voidCompletion(deps: Deps, req: { completionId: string; personId: string }): Promise<WithdrawResult> {
  return withdraw(deps, req, "void");
}

async function withdraw(
  { db, clock }: Deps,
  req: { completionId: string; personId: string },
  kind: "undo" | "void",
): Promise<WithdrawResult> {
  if (!UUID.test(req.completionId)) return { ok: false, error: "not_found" };
  const now = clock.now();
  return db.begin(async (tx) => {
    const [c] = await tx`
      SELECT id, occurrence_id, household_id, completer_id, completed_at, voided_at
      FROM completions WHERE id = ${req.completionId}::uuid FOR UPDATE`;
    if (!c) return { ok: false, error: "not_found" } as const;
    const membership = await findMembership(tx, c.household_id, req.personId);
    if (!membership) return { ok: false, error: "not_found" } as const;

    if (kind === "undo") {
      if (c.completer_id !== req.personId) return { ok: false, error: "forbidden" } as const;
      if (now.getTime() - new Date(c.completed_at).getTime() > UNDO_WINDOW_MS) {
        return { ok: false, error: "undo_expired" } as const;
      }
    } else if (membership.role !== "admin") {
      return { ok: false, error: "forbidden" } as const;
    }
    if (c.voided_at) return { ok: false, error: "already_voided" } as const;

    await tx`UPDATE completions SET voided_at = ${now}, voided_by = ${req.personId} WHERE id = ${c.id}`;
    const [occ] = await tx`
      UPDATE occurrences
      SET status = CASE WHEN window_end IS NOT NULL AND window_end <= ${now} THEN 'missed' ELSE 'open' END
      WHERE id = ${c.occurrence_id}
      RETURNING id, status`;
    return { ok: true, occurrence: { id: occ.id, status: occ.status } } as const;
  });
}

/** Excuse: Admins only; an Open or Missed Occurrence becomes Skipped with the note. */
export async function excuseOccurrence(
  { db, clock }: Deps,
  req: { occurrenceId: string; personId: string; note: unknown },
): Promise<ExcuseResult> {
  if (!UUID.test(req.occurrenceId)) return { ok: false, error: "not_found" };
  const now = clock.now();
  const [occ] = await db`SELECT id, household_id FROM occurrences WHERE id = ${req.occurrenceId}::uuid`;
  if (!occ) return { ok: false, error: "not_found" };
  const membership = await findMembership(db, occ.household_id, req.personId);
  if (!membership) return { ok: false, error: "not_found" };
  if (membership.role !== "admin") return { ok: false, error: "forbidden" };

  const note = typeof req.note === "string" ? req.note.trim() : "";
  if (!note || note.length > EXCUSE_NOTE_MAX) return { ok: false, error: "note_required" };

  const updated = await db`
    UPDATE occurrences
    SET status = 'skipped', excused_at = ${now}, excused_by = ${req.personId}, excuse_note = ${note}
    WHERE id = ${occ.id} AND status IN ('open', 'missed')
    RETURNING id`;
  if (updated.length === 0) return { ok: false, error: "not_excusable" };
  return { ok: true, occurrence: { id: occ.id, status: "skipped" } };
}

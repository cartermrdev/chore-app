/**
 * The end of a Chore's life. Archiving keeps history and is always allowed;
 * hard delete is allowed only while the Chore has no history (no
 * Completions, voided or not). See GLOSSARY "Archived".
 */
import type { Clock } from "../clock";
import type { Db } from "../db/client";

export type ArchivedChore = { id: string; name: string; archivedAt: Date };

/**
 * Archives the Chore: it stops producing Occurrences (the materialiser skips
 * Archived Chores), its stored Occurrences and Completions stay readable, and
 * every Tag pointing at it is unlinked (chore_id NULL). Archiving again keeps
 * the original archive time. Null when the Chore isn't in the Household.
 */
export async function archiveChore(
  deps: { db: Db; clock: Clock },
  input: { householdId: string; choreId: string },
): Promise<ArchivedChore | null> {
  const { db, clock } = deps;
  return db.begin(async (tx) => {
    const [row] = await tx`
      UPDATE chores SET archived_at = COALESCE(archived_at, ${clock.now()})
      WHERE id = ${input.choreId}::uuid AND household_id = ${input.householdId}
      RETURNING id, name, archived_at`.catch(() => []);
    if (!row) return null;
    await tx`UPDATE tags SET chore_id = NULL WHERE chore_id = ${row.id}`;
    return { id: row.id, name: row.name, archivedAt: row.archived_at };
  });
}

export type DeleteResult = { ok: true } | { ok: false; error: "not_found" | "has_history" };

/**
 * Hard-deletes a Chore that has no Completions, with its (unhistoried)
 * Occurrences; its Tags are left registered but unlinked. A Chore with any
 * Completion must be Archived instead.
 */
export async function deleteChore(db: Db, input: { householdId: string; choreId: string }): Promise<DeleteResult> {
  try {
    return await db.begin(async (tx) => {
      const [chore] = await tx`
        SELECT id FROM chores
        WHERE id = ${input.choreId}::uuid AND household_id = ${input.householdId}
        FOR UPDATE`.catch(() => []);
      if (!chore) return { ok: false, error: "not_found" } as const;
      // History: any Completion (voided ones included) or any Excuse.
      const [history] = await tx`
        SELECT 1 FROM completions c JOIN occurrences o ON o.id = c.occurrence_id
        WHERE o.chore_id = ${chore.id}
        UNION ALL
        SELECT 1 FROM occurrences WHERE chore_id = ${chore.id} AND excused_at IS NOT NULL
        LIMIT 1`;
      if (history) return { ok: false, error: "has_history" } as const;
      await tx`UPDATE tags SET chore_id = NULL WHERE chore_id = ${chore.id}`;
      await tx`DELETE FROM occurrences WHERE chore_id = ${chore.id}`;
      await tx`DELETE FROM chores WHERE id = ${chore.id}`;
      return { ok: true } as const;
    });
  } catch (e) {
    // A Completion landed concurrently: its foreign key blocks the delete.
    if (isForeignKeyViolation(e)) return { ok: false, error: "has_history" };
    throw e;
  }
}

export function isForeignKeyViolation(e: unknown): boolean {
  const err = e as { errno?: string; code?: string };
  return err?.errno === "23503" || err?.code === "23503";
}

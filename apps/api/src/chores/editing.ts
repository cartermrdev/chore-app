/**
 * Creating a Chore and editing its name, Schedule and Assignee. A new
 * Schedule replaces the old one and applies only to Occurrences not yet
 * created (see the materialiser). Every Assignee (the Chore's and each Time
 * Slot's) must be a Person with a current Membership in the Household.
 */
import type { Db } from "../db/client";
import { currentPersonIds } from "../households/access";
import { slotAssigneeIds, type Schedule } from "../schedule/engine";
import { personRef } from "./views";
import type { PersonRef } from "../completions/service";

/** { id, name, schedule, assignee } as returned by create and edit. */
export type ChoreSummary = { id: string; name: string; schedule: Schedule; assignee: PersonRef | null };

export type EditError = "not_found" | "invalid_assignee";

export async function createChore(
  deps: { db: Db; now: Date },
  input: { householdId: string; name: string; schedule: Schedule; assigneeId: string | null },
): Promise<{ ok: true; chore: ChoreSummary } | { ok: false; error: "invalid_assignee" }> {
  const { db, now } = deps;
  if (!(await validAssignees(db, input.householdId, input.assigneeId, input.schedule))) {
    return { ok: false, error: "invalid_assignee" };
  }
  const [row] = await db`
    INSERT INTO chores (household_id, name, schedule, assignee_id, created_at)
    VALUES (${input.householdId}, ${input.name}, ${input.schedule}, ${input.assigneeId}, ${now})
    RETURNING id`;
  return { ok: true, chore: await choreSummary(db, row.id) };
}

/**
 * Edits a non-archived Chore. Each field is optional: `name`/`schedule`
 * undefined keep the current value; `assigneeId` undefined keeps it, null clears it.
 */
export async function editChore(
  db: Db,
  input: {
    householdId: string;
    choreId: string;
    name?: string;
    schedule?: Schedule;
    assigneeId?: string | null;
  },
): Promise<{ ok: true; chore: ChoreSummary } | { ok: false; error: EditError }> {
  if (!(await validAssignees(db, input.householdId, input.assigneeId, input.schedule ?? null))) {
    return { ok: false, error: "invalid_assignee" };
  }
  const setAssignee = input.assigneeId !== undefined;
  const [row] = await db`
    UPDATE chores SET
      name = COALESCE(${input.name ?? null}, name),
      schedule = COALESCE(${input.schedule ?? null}::jsonb, schedule),
      assignee_id = CASE WHEN ${setAssignee} THEN ${input.assigneeId ?? null}::uuid ELSE assignee_id END
    WHERE household_id = ${input.householdId} AND id = ${input.choreId}::uuid AND archived_at IS NULL
    RETURNING id`.catch(() => []);
  if (!row) return { ok: false, error: "not_found" };
  return { ok: true, chore: await choreSummary(db, row.id) };
}

/** The Chore's Assignee (undefined/null: none given) and its Time Slots' Assignees all have current Memberships here. */
async function validAssignees(
  db: Db,
  householdId: string,
  choreAssigneeId: string | null | undefined,
  schedule: Schedule | null,
): Promise<boolean> {
  const ids = [...new Set([...(choreAssigneeId ? [choreAssigneeId] : []), ...(schedule ? slotAssigneeIds(schedule) : [])])];
  const current = await currentPersonIds(db, householdId, ids);
  return ids.every((id) => current.has(id));
}

async function choreSummary(db: Db, choreId: string): Promise<ChoreSummary> {
  const [row] = await db`
    SELECT c.id, c.name, c.schedule, c.assignee_id, p.display_name
    FROM chores c LEFT JOIN persons p ON p.id = c.assignee_id
    WHERE c.id = ${choreId}`;
  return { id: row.id, name: row.name, schedule: row.schedule, assignee: personRef(row.assignee_id, row.display_name) };
}

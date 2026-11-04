import { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireSession } from "../auth/sessions";
import { requireAdmin, requireMembership } from "../households/membership";
import { localDateOf } from "../schedule/calendar";
import { parseSchedule, slotAssigneeIds, type Schedule } from "../schedule/engine";
import { currentMemberIds } from "../households/membership";
import type { Db } from "../db/client";
import { getChore, listChores, personRef } from "./views";
import { completeDueOccurrence } from "../completions/service";

/** /api/households/:householdId/chores */
export const choreRoutes = new Hono<AppEnv>()
  .use(requireSession, requireMembership)
  .get("/", async (c) => {
    const { db, clock } = c.var.deps;
    const chores = await listChores({ db, membership: c.var.membership, now: clock.now() });
    return c.json({ chores });
  })
  .get("/:choreId", async (c) => {
    const { db, clock } = c.var.deps;
    const chore = await getChore({ db, membership: c.var.membership, now: clock.now() }, c.req.param("choreId"));
    if (!chore) return c.json({ error: "not_found" }, 404);
    return c.json(chore);
  })
  .post("/:choreId/complete", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const idempotencyKey = body?.idempotencyKey;
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 200) {
      return c.json({ error: "idempotencyKey is required" }, 400);
    }
    const result = await completeDueOccurrence(c.var.deps, {
      householdId: c.var.membership.householdId,
      choreId: c.req.param("choreId"),
      completerId: c.var.personId,
      recorderId: c.var.personId,
      method: "manual",
      idempotencyKey,
    });
    switch (result.outcome) {
      case "completed":
      case "already_completed":
      case "nothing_due":
        return c.json(result);
      case "chore_not_found":
        return c.json({ error: "not_found" }, 404);
      case "not_a_member":
        return c.json({ error: "not_found" }, 404);
      case "forbidden":
        return c.json({ error: "forbidden" }, 403);
    }
  })
  /**
   * Edit a Chore's name and/or Schedule. The new Schedule replaces the old one
   * and applies only to Occurrences not yet created (see the materialiser).
   */
  .patch("/:choreId", requireAdmin, async (c) => {
    const { db, clock } = c.var.deps;
    const { householdId, timeZone } = c.var.membership;
    const body = await c.req.json().catch(() => ({}));

    let name: string | null = null;
    if (body?.name !== undefined) {
      name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return c.json({ error: "name is required" }, 400);
    }
    let schedule = null;
    if (body?.schedule !== undefined) {
      const parsed = parseSchedule(body.schedule, localDateOf(clock.now(), timeZone));
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      schedule = parsed.schedule;
    }
    const setAssignee = body?.assigneeId !== undefined;
    const invalid = await invalidAssignees(db, householdId, body?.assigneeId, schedule);
    if (invalid) return c.json({ error: invalid }, 400);

    const [row] = await db`
      UPDATE chores SET
        name = COALESCE(${name}, name),
        schedule = COALESCE(${schedule}::jsonb, schedule),
        assignee_id = CASE WHEN ${setAssignee} THEN ${body?.assigneeId ?? null}::uuid ELSE assignee_id END
      WHERE household_id = ${householdId} AND id = ${c.req.param("choreId")}::uuid AND archived_at IS NULL
      RETURNING id`.catch(() => []);
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json(await choreSummary(db, row.id));
  })
  .post("/", requireAdmin, async (c) => {
    const { db, clock } = c.var.deps;
    const { householdId, timeZone } = c.var.membership;
    const body = await c.req.json().catch(() => ({}));

    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name is required" }, 400);
    const now = clock.now();
    const parsed = parseSchedule(body?.schedule, localDateOf(now, timeZone));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const invalid = await invalidAssignees(db, householdId, body?.assigneeId, parsed.schedule);
    if (invalid) return c.json({ error: invalid }, 400);

    const [row] = await db`
      INSERT INTO chores (household_id, name, schedule, assignee_id, created_at)
      VALUES (${householdId}, ${name}, ${parsed.schedule}, ${body?.assigneeId ?? null}, ${now})
      RETURNING id`;
    return c.json(await choreSummary(db, row.id), 201);
  });

/**
 * Checks a Chore's Assignee (undefined: unchanged, null: none) and its Time
 * Slots' Assignees: each must be a Person with a current Membership here.
 * Returns an error message, or null when valid.
 */
async function invalidAssignees(
  db: Db,
  householdId: string,
  choreAssigneeId: unknown,
  schedule: Schedule | null,
): Promise<string | null> {
  if (choreAssigneeId !== undefined && choreAssigneeId !== null && typeof choreAssigneeId !== "string") {
    return "assigneeId must be a Person id or null";
  }
  const ids = [...new Set([...(typeof choreAssigneeId === "string" ? [choreAssigneeId] : []), ...(schedule ? slotAssigneeIds(schedule) : [])])];
  const members = await currentMemberIds(db, householdId, ids);
  return ids.every((id) => members.has(id)) ? null : "each Assignee must be a Person in this Household";
}

/** { id, name, schedule, assignee } as returned by create and edit. */
async function choreSummary(db: Db, choreId: string) {
  const [row] = await db`
    SELECT c.id, c.name, c.schedule, c.assignee_id, p.display_name
    FROM chores c LEFT JOIN persons p ON p.id = c.assignee_id
    WHERE c.id = ${choreId}`;
  return { id: row.id, name: row.name, schedule: row.schedule, assignee: personRef(row.assignee_id, row.display_name) };
}

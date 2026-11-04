import { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireSession } from "../auth/sessions";
import { requireAdmin, requireMembership } from "../households/access";
import { localDateOf } from "../schedule/calendar";
import { parseSchedule, type Schedule } from "../schedule/engine";
import { getChore, listChores } from "./views";
import { archiveChore, deleteChore } from "./lifecycle";
import { createChore, editChore } from "./editing";
import { completeDueOccurrence, completeEarly, idempotencyKeyOf, parseEarlyTarget } from "../completions/service";
import { outcomeResponse } from "../completions/outcome-status";

const INVALID_ASSIGNEE = "each Assignee must be a Person in this Household";

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
    const idempotencyKey = idempotencyKeyOf(body);
    if (!idempotencyKey) return c.json({ error: "idempotencyKey is required" }, 400);
    // Optional: an Admin records on someone else's behalf (the session Person is the Recorder).
    const completerId = body?.completerId ?? c.var.personId;
    if (typeof completerId !== "string") return c.json({ error: "completerId must be a Person id" }, 400);
    const result = await completeDueOccurrence(c.var.deps, {
      householdId: c.var.membership.householdId,
      choreId: c.req.param("choreId"),
      completerId,
      recorderId: c.var.personId,
      method: "manual",
      idempotencyKey,
    });
    return outcomeResponse(c, result);
  })
  /**
   * Early Completion: an explicit request naming the next Occurrence
   * ({ idempotencyKey, dueDate, timeSlot?, completerId? }).
   */
  .post("/:choreId/complete-early", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const idempotencyKey = idempotencyKeyOf(body);
    if (!idempotencyKey) return c.json({ error: "idempotencyKey is required" }, 400);
    const completerId = body?.completerId ?? c.var.personId;
    if (typeof completerId !== "string") return c.json({ error: "completerId must be a Person id" }, 400);
    const target = parseEarlyTarget(body);
    if (!target) return c.json({ error: "dueDate (YYYY-MM-DD) is required" }, 400);
    const result = await completeEarly(c.var.deps, {
      householdId: c.var.membership.householdId,
      choreId: c.req.param("choreId"),
      completerId,
      recorderId: c.var.personId,
      method: "manual",
      idempotencyKey,
      ...target,
    });
    return outcomeResponse(c, result);
  })
  /**
   * Edit a Chore's name, Schedule and/or Assignee (see chores/editing). The new
   * Schedule applies only to Occurrences not yet created.
   */
  .patch("/:choreId", requireAdmin, async (c) => {
    const { db, clock } = c.var.deps;
    const { householdId, timeZone } = c.var.membership;
    const body = await c.req.json().catch(() => ({}));

    let name: string | undefined;
    if (body?.name !== undefined) {
      name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return c.json({ error: "name is required" }, 400);
    }
    let schedule: Schedule | undefined;
    if (body?.schedule !== undefined) {
      const parsed = parseSchedule(body.schedule, localDateOf(clock.now(), timeZone));
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      schedule = parsed.schedule;
    }
    const assigneeId = body?.assigneeId;
    if (!isAssigneeId(assigneeId)) return c.json({ error: "assigneeId must be a Person id or null" }, 400);

    const result = await editChore(db, { householdId, choreId: c.req.param("choreId"), name, schedule, assigneeId });
    if (result.ok) return c.json(result.chore);
    if (result.error === "invalid_assignee") return c.json({ error: INVALID_ASSIGNEE }, 400);
    return c.json({ error: "not_found" }, 404);
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
    const assigneeId = body?.assigneeId;
    if (!isAssigneeId(assigneeId)) return c.json({ error: "assigneeId must be a Person id or null" }, 400);

    const result = await createChore({ db, now }, { householdId, name, schedule: parsed.schedule, assigneeId: assigneeId ?? null });
    if (!result.ok) return c.json({ error: INVALID_ASSIGNEE }, 400);
    return c.json(result.chore, 201);
  })
  .post("/:choreId/archive", requireAdmin, async (c) => {
    const archived = await archiveChore(c.var.deps, {
      householdId: c.var.membership.householdId,
      choreId: c.req.param("choreId"),
    });
    if (!archived) return c.json({ error: "not_found" }, 404);
    return c.json(archived);
  })
  .delete("/:choreId", requireAdmin, async (c) => {
    const result = await deleteChore(c.var.deps.db, {
      householdId: c.var.membership.householdId,
      choreId: c.req.param("choreId"),
    });
    if (result.ok) return c.body(null, 204);
    if (result.error === "has_history") return c.json({ error: "has_history" }, 409);
    return c.json({ error: "not_found" }, 404);
  });

/** An Assignee in a request body: undefined (unchanged), null (none) or a Person id. */
function isAssigneeId(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

import { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireSession } from "../auth/sessions";
import { requireAdmin, requireMembership } from "../households/membership";
import { localDateOf } from "../schedule/calendar";
import { parseSchedule } from "../schedule/engine";
import { getChore, listChores } from "./views";
import { archiveChore, deleteChore } from "./lifecycle";
import { completeDueOccurrence, completeEarly, parseEarlyTarget, type CompleteResult } from "../completions/service";
import type { Context } from "hono";

function completionResponse(c: Context<AppEnv>, result: CompleteResult) {
  switch (result.outcome) {
    case "completed":
    case "already_completed":
    case "nothing_due":
      return c.json(result);
    case "chore_not_found":
      return c.json({ error: "not_found" }, 404);
    case "not_a_member":
      // The Recorder passed requireMembership, so it's the Completer who isn't a current Person here.
      return c.json({ error: "completer_not_a_member" }, 400);
    case "forbidden":
      return c.json({ error: "forbidden" }, 403);
  }
}

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
    return completionResponse(c, result);
  })
  /**
   * Early Completion: an explicit request naming the next Occurrence
   * ({ idempotencyKey, dueDate, timeSlot?, completerId? }).
   */
  .post("/:choreId/complete-early", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const idempotencyKey = body?.idempotencyKey;
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 200) {
      return c.json({ error: "idempotencyKey is required" }, 400);
    }
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
    return completionResponse(c, result);
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

    const [row] = await db`
      UPDATE chores SET
        name = COALESCE(${name}, name),
        schedule = COALESCE(${schedule}::jsonb, schedule)
      WHERE household_id = ${householdId} AND id = ${c.req.param("choreId")}::uuid AND archived_at IS NULL
      RETURNING id, name, schedule`.catch(() => []);
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ id: row.id, name: row.name, schedule: row.schedule });
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

    const [row] = await db`
      INSERT INTO chores (household_id, name, schedule, created_at)
      VALUES (${householdId}, ${name}, ${parsed.schedule}, ${now})
      RETURNING id, name, schedule`;
    return c.json({ id: row.id, name: row.name, schedule: row.schedule }, 201);
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

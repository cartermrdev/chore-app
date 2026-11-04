import { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireSession } from "../auth/sessions";
import { requireAdmin, requireMembership } from "../households/membership";
import { localDateOf } from "../schedule/calendar";
import { parseSchedule } from "../schedule/engine";
import { getChore, listChores } from "./views";
import { archiveChore, deleteChore } from "./lifecycle";
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

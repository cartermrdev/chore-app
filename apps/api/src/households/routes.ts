import { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireSession } from "../auth/sessions";
import { requireAdmin, requireMembership } from "./membership";
import { isValidTimeZone } from "./seed";

/**
 * /api/households/:householdId: Household settings.
 * PATCH { timeZone } (Admin): an IANA zone. Stored Occurrences keep their
 * instants; Occurrences created afterwards are planned in the new zone.
 */
export const householdRoutes = new Hono<AppEnv>()
  // Middleware per route, not .use(): this router is mounted at the Household's
  // root, so .use() would also run on /chores, /tags, etc.
  .patch("/", requireSession, requireMembership, requireAdmin, async (c) => {
    const { db } = c.var.deps;
    const body = await c.req.json().catch(() => ({}));
    const timeZone = body?.timeZone;
    if (typeof timeZone !== "string" || !timeZone || !isValidTimeZone(timeZone)) {
      return c.json({ error: "timeZone must be an IANA time zone" }, 400);
    }
    const [row] = await db`
      UPDATE households SET time_zone = ${timeZone}
      WHERE id = ${c.var.membership.householdId}
      RETURNING id, name, time_zone`;
    return c.json({ id: row.id, name: row.name, timeZone: row.time_zone });
  });

/** GET /api/me: the signed-in Person and their current Memberships. */
export const meRoutes = new Hono<AppEnv>().use(requireSession).get("/", async (c) => {
  const { db } = c.var.deps;
  const personId = c.var.personId;

  const [person] = await db`SELECT id, display_name FROM persons WHERE id = ${personId}`;
  const memberships = await db`
    SELECT m.role, h.id, h.name, h.time_zone
    FROM memberships m JOIN households h ON h.id = m.household_id
    WHERE m.person_id = ${personId} AND m.ended_at IS NULL
    ORDER BY h.name`;

  return c.json({
    person: { id: person.id, displayName: person.display_name },
    memberships: memberships.map((m: any) => ({
      role: m.role,
      household: { id: m.id, name: m.name, timeZone: m.time_zone },
    })),
  });
});

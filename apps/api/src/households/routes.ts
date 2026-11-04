import { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireSession } from "../auth/sessions";

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

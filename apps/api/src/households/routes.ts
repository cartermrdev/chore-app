import { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireSession } from "../auth/sessions";
import { normaliseEmail } from "../auth/magic-links";

/**
 * GET /api/me: the signed-in Person ({ id, displayName, email }) and their current Memberships.
 * PATCH /api/me { email: string | null }: sets or clears the Person's email
 *   (used for magic-link sign-in). 400 if invalid, 409 if another Person has it.
 */
export const meRoutes = new Hono<AppEnv>()
  .use(requireSession)
  .get("/", async (c) => {
    const { db } = c.var.deps;
    const personId = c.var.personId;

    const [person] = await db`SELECT id, display_name, email FROM persons WHERE id = ${personId}`;
    const memberships = await db`
      SELECT m.role, h.id, h.name, h.time_zone
      FROM memberships m JOIN households h ON h.id = m.household_id
      WHERE m.person_id = ${personId} AND m.ended_at IS NULL
      ORDER BY h.name`;

    return c.json({
      person: { id: person.id, displayName: person.display_name, email: person.email },
      memberships: memberships.map((m: any) => ({
        role: m.role,
        household: { id: m.id, name: m.name, timeZone: m.time_zone },
      })),
    });
  })
  .patch("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body || !("email" in body)) return c.json({ error: "email is required" }, 400);
    const email = body.email === null ? null : normaliseEmail(body.email);
    if (body.email !== null && !email) return c.json({ error: "invalid email" }, 400);

    const { db } = c.var.deps;
    const taken = email ? await db`SELECT 1 FROM persons WHERE email = ${email} AND id <> ${c.var.personId}` : [];
    if (taken.length > 0) return c.json({ error: "email_taken" }, 409);
    try {
      await db`UPDATE persons SET email = ${email} WHERE id = ${c.var.personId}`;
    } catch {
      return c.json({ error: "email_taken" }, 409); // lost a race on the unique index
    }
    return c.json({ ok: true });
  });

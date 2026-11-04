import { Hono } from "hono";
import type { AppEnv } from "../app";
import { startSession } from "../auth/sessions";
import { seedHousehold } from "../households/seed";

/**
 * Test-only endpoints under /api/test. Mounted only when config.testAuth is
 * true, which config.ts forbids in production. Used by the API harness and
 * by e2e tests to set up state; later tickets may add fixture endpoints here.
 *
 * POST /api/test/sign-in { personId }  creates a session (stands in for passkeys).
 * POST /api/test/seed { householdName, timeZone, adminName }  same as `bun run seed`.
 */
export const testRoutes = new Hono<AppEnv>()
  .post("/sign-in", async (c) => {
    const body = await c.req.json().catch(() => null);
    const personId = body?.personId;
    if (typeof personId !== "string") return c.json({ error: "personId required" }, 400);

    const { db } = c.var.deps;
    const found = await db`SELECT 1 FROM persons WHERE id = ${personId}::uuid`.catch(() => []);
    if (found.length === 0) return c.json({ error: "unknown person" }, 404);

    await startSession(c, personId);
    return c.json({ ok: true });
  })
  // POST /api/test/add-person { householdId, displayName, role? } -> { id, displayName }
  // Adds a Person with a current Membership (e2e setup; stands in for Invites).
  .post("/add-person", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { householdId, displayName } = body ?? {};
    const role = body?.role ?? "standard";
    if (typeof householdId !== "string" || typeof displayName !== "string" || !["admin", "standard"].includes(role)) {
      return c.json({ error: "householdId, displayName and role admin|standard required" }, 400);
    }
    const { db, clock } = c.var.deps;
    const now = clock.now();
    const person = await db.begin(async (tx) => {
      const [p] = await tx`INSERT INTO persons (display_name, created_at) VALUES (${displayName}, ${now}) RETURNING id`;
      await tx`
        INSERT INTO memberships (household_id, person_id, role, created_at)
        VALUES (${householdId}, ${p.id}, ${role}, ${now})`;
      return p;
    });
    return c.json({ id: person.id, displayName });
  })
  .post("/seed", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { db, clock } = c.var.deps;
    try {
      return c.json(await seedHousehold(db, clock, body));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

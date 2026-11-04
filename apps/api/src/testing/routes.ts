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
  .post("/seed", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { db, clock } = c.var.deps;
    try {
      return c.json(await seedHousehold(db, clock, body));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

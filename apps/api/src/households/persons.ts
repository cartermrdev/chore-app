import { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireSession } from "../auth/sessions";
import { requireAdmin, requireMembership, type Role } from "./access";
import { changeRole, endMembership, type MembershipError } from "./membership-changes";

const STATUS = { not_found: 404, forbidden: 403, last_admin: 409 } as const satisfies Record<MembershipError, number>;

/**
 * /api/households/:householdId/persons: the Household's Memberships.
 *
 * GET -> { persons: { id, displayName, role }[] }
 *   Persons with a current Membership, ordered by display name. Visible to every
 *   Person in the Household; outsiders get 404.
 * PATCH /:personId { role: "admin"|"standard" } (Admin) -> { id, displayName, role }
 *   409 last_admin if it would leave the Household without an Admin.
 * DELETE /:personId (Admin) -> 204: ends the Membership (Admins may end their own).
 *   409 last_admin for the last Admin. Past Completions keep the Person's name.
 * Both: 404 if the Person has no current Membership here; 403 for Standard Persons.
 */
export const personRoutes = new Hono<AppEnv>()
  .use(requireSession, requireMembership)
  .get("/", async (c) => {
    const rows = await c.var.deps.db`
      SELECT p.id, p.display_name, m.role
      FROM memberships m JOIN persons p ON p.id = m.person_id
      WHERE m.household_id = ${c.var.membership.householdId} AND m.ended_at IS NULL
      ORDER BY p.display_name, p.id`;
    return c.json({ persons: rows.map((r: any) => ({ id: r.id, displayName: r.display_name, role: r.role })) });
  })
  .patch("/:personId", requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const role: unknown = body?.role;
    if (role !== "admin" && role !== "standard") return c.json({ error: "role must be admin or standard" }, 400);
    const result = await changeRole(c.var.deps, {
      householdId: c.var.membership.householdId,
      personId: c.req.param("personId"),
      actorId: c.var.personId,
      role: role as Role,
    });
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error]);
    return c.json(result.person);
  })
  .delete("/:personId", requireAdmin, async (c) => {
    const result = await endMembership(c.var.deps, {
      householdId: c.var.membership.householdId,
      personId: c.req.param("personId"),
      actorId: c.var.personId,
    });
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error]);
    return c.body(null, 204);
  });

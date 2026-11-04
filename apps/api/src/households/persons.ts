import { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireSession } from "../auth/sessions";
import { requireMembership } from "./membership";

/**
 * GET /api/households/:householdId/persons -> { persons: { id, displayName, role }[] }
 * The Household's Persons with a current Membership, ordered by display name.
 * Visible to every Person in the Household (used e.g. to pick a Completer
 * when an Admin records on someone's behalf); outsiders get 404.
 */
export const personRoutes = new Hono<AppEnv>().use(requireSession, requireMembership).get("/", async (c) => {
  const rows = await c.var.deps.db`
    SELECT p.id, p.display_name, m.role
    FROM memberships m JOIN persons p ON p.id = m.person_id
    WHERE m.household_id = ${c.var.membership.householdId} AND m.ended_at IS NULL
    ORDER BY p.display_name, p.id`;
  return c.json({ persons: rows.map((r: any) => ({ id: r.id, displayName: r.display_name, role: r.role })) });
});

/**
 * Access to a Household: who has a current Membership there, and the route
 * guards built on it. Changing Memberships lives in membership-changes.ts.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app";
import type { Db } from "../db/client";

export type Role = "admin" | "standard";

export type CurrentMembership = {
  householdId: string;
  personId: string;
  role: Role;
  timeZone: string;
};

/** The Person's current Membership in the Household, or null (also for malformed ids). */
export async function findMembership(db: Db, householdId: string, personId: string): Promise<CurrentMembership | null> {
  const rows = await db`
    SELECT m.role, h.time_zone
    FROM memberships m JOIN households h ON h.id = m.household_id
    WHERE m.household_id = ${householdId}::uuid AND m.person_id = ${personId} AND m.ended_at IS NULL`.catch(
    () => [],
  );
  const row = rows[0];
  if (!row) return null;
  return { householdId, personId, role: row.role, timeZone: row.time_zone };
}

/**
 * The Persons with a current Membership in the Household: all of them, or
 * only those among `personIds` (malformed ids never match).
 */
export async function currentPersonIds(db: Db, householdId: string, personIds?: string[]): Promise<Set<string>> {
  if (personIds?.length === 0) return new Set();
  const rows = await db`
    SELECT person_id::text FROM memberships
    WHERE household_id = ${householdId}::uuid AND ended_at IS NULL
      ${personIds ? db`AND person_id::text IN ${db(personIds)}` : db``}`;
  return new Set(rows.map((r: any) => r.person_id as string));
}

/**
 * For routes under /households/:householdId. Requires requireSession first.
 * Non-members get 404 so a Household reveals nothing to outsiders.
 */
export const requireMembership: MiddlewareHandler<AppEnv> = async (c, next) => {
  const householdId = c.req.param("householdId");
  if (!householdId) return c.json({ error: "not_found" }, 404);
  const membership = await findMembership(c.var.deps.db, householdId, c.var.personId);
  if (!membership) return c.json({ error: "not_found" }, 404);
  c.set("membership", membership);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.membership.role !== "admin") return c.json({ error: "forbidden" }, 403);
  await next();
};

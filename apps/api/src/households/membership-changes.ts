/**
 * Membership management: changing Roles and ending Memberships.
 *
 * Invariant: a Household always has at least one current Admin Membership.
 * Every change that could remove an Admin runs in a transaction that first
 * locks the Household row, so concurrent changes are serialised per Household
 * and can't together remove the last Admin.
 */
import type { Deps } from "../app";
import type { Db } from "../db/client";
import { findMembership, type Role } from "./access";

export type MembershipPerson = { id: string; displayName: string; role: Role };
export type MembershipError = "not_found" | "forbidden" | "last_admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Locked = { membershipId: string; displayName: string; role: Role; otherAdmins: number };

/**
 * Locks the Household, re-checks under the lock that the actor is still an Admin
 * (they may have been demoted by a concurrent request), and loads the target
 * Person's current Membership there.
 */
async function lockMembership(
  tx: Db,
  input: { householdId: string; personId: string; actorId: string },
): Promise<Locked | "forbidden" | null> {
  const { householdId, personId, actorId } = input;
  await tx`SELECT id FROM households WHERE id = ${householdId} FOR UPDATE`;
  const actor = await findMembership(tx, householdId, actorId);
  if (actor?.role !== "admin") return "forbidden";
  if (!UUID.test(personId)) return null;
  const [row] = await tx`
    SELECT m.id, m.role, p.display_name,
      (SELECT count(*)::int FROM memberships o
        WHERE o.household_id = m.household_id AND o.ended_at IS NULL
          AND o.role = 'admin' AND o.id <> m.id) AS other_admins
    FROM memberships m JOIN persons p ON p.id = m.person_id
    WHERE m.household_id = ${householdId} AND m.person_id = ${personId} AND m.ended_at IS NULL`;
  if (!row) return null;
  return { membershipId: row.id, displayName: row.display_name, role: row.role, otherAdmins: row.other_admins };
}

export async function changeRole(
  deps: Pick<Deps, "db">,
  input: { householdId: string; personId: string; actorId: string; role: Role },
): Promise<{ ok: true; person: MembershipPerson } | { ok: false; error: MembershipError }> {
  return deps.db.begin(async (tx: Db) => {
    const m = await lockMembership(tx, input);
    if (m === "forbidden") return { ok: false, error: "forbidden" } as const;
    if (!m) return { ok: false, error: "not_found" } as const;
    if (m.role === "admin" && input.role !== "admin" && m.otherAdmins === 0) {
      return { ok: false, error: "last_admin" } as const;
    }
    await tx`UPDATE memberships SET role = ${input.role} WHERE id = ${m.membershipId}`;
    return { ok: true, person: { id: input.personId, displayName: m.displayName, role: input.role } } as const;
  });
}

/**
 * Ends the Person's current Membership. The Person keeps their identity, so past
 * Completions stay attributed to them; access stops at once because every
 * Household route requires a current Membership.
 */
export async function endMembership(
  deps: Pick<Deps, "db" | "clock">,
  input: { householdId: string; personId: string; actorId: string },
): Promise<{ ok: true } | { ok: false; error: MembershipError }> {
  return deps.db.begin(async (tx: Db) => {
    const m = await lockMembership(tx, input);
    if (m === "forbidden") return { ok: false, error: "forbidden" } as const;
    if (!m) return { ok: false, error: "not_found" } as const;
    if (m.role === "admin" && m.otherAdmins === 0) return { ok: false, error: "last_admin" } as const;
    await tx`UPDATE memberships SET ended_at = ${deps.clock.now()} WHERE id = ${m.membershipId}`;
    return { ok: true } as const;
  });
}

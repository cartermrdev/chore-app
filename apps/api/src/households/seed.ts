import type { Clock } from "../clock";
import type { Db } from "../db/client";

export type SeedInput = {
  householdName: string;
  timeZone: string;
  adminName: string;
  adminEmail?: string;
};

export type SeedResult = {
  household: { id: string; name: string; timeZone: string };
  person: { id: string; displayName: string };
  membership: { id: string; role: "admin" };
};

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a Household, a Person, and an Admin Membership linking them.
 * This is the only way a Household comes into existence (ADR 0002: signup is closed).
 */
export async function seedHousehold(db: Db, clock: Clock, input: SeedInput): Promise<SeedResult> {
  if (!input.householdName.trim()) throw new Error("householdName is required");
  if (!input.adminName.trim()) throw new Error("adminName is required");
  if (!isValidTimeZone(input.timeZone)) throw new Error(`Unknown time zone "${input.timeZone}"`);

  const now = clock.now();
  return db.begin(async (tx) => {
    const [household] = await tx`
      INSERT INTO households (name, time_zone, created_at)
      VALUES (${input.householdName}, ${input.timeZone}, ${now})
      RETURNING id, name, time_zone`;
    const [person] = await tx`
      INSERT INTO persons (display_name, email, created_at)
      VALUES (${input.adminName}, ${input.adminEmail?.trim().toLowerCase() || null}, ${now})
      RETURNING id, display_name`;
    const [membership] = await tx`
      INSERT INTO memberships (household_id, person_id, role, created_at)
      VALUES (${household.id}, ${person.id}, 'admin', ${now})
      RETURNING id`;
    return {
      household: { id: household.id, name: household.name, timeZone: household.time_zone },
      person: { id: person.id, displayName: person.display_name },
      membership: { id: membership.id, role: "admin" as const },
    };
  });
}

import { describe, expect, test } from "bun:test";
import { useTestApp } from "./harness";

describe("seeding a Household", () => {
  const t = useTestApp();

  test("rejects an unknown time zone", async () => {
    await expect(t.seed({ timeZone: "Mars/Olympus_Mons" })).rejects.toThrow(/time zone/);
  });

  test("two seeded Households are separate: each Admin sees only their own", async () => {
    const a = await t.seed({ householdName: "North House" });
    await t.seed({ householdName: "South House" });

    const body = await (await (await t.signIn(a.person.id)).get("/api/me")).json();

    expect(body.memberships.map((m: any) => m.household.name)).toEqual(["North House"]);
  });
});

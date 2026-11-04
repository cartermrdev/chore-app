import { describe, expect, test } from "bun:test";
import { useTestApp } from "./harness";

describe("the signed-in Person's Households", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });

  test("a seeded Admin who signs in sees their Household's name", async () => {
    const { person } = await t.seed({
      householdName: "The Smiths",
      timeZone: "Europe/London",
      adminName: "Alex",
    });
    const alex = await t.signIn(person.id);

    const res = await alex.get("/api/me");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.person.displayName).toBe("Alex");
    expect(body.memberships).toEqual([
      {
        role: "admin",
        household: expect.objectContaining({
          name: "The Smiths",
          timeZone: "Europe/London",
        }),
      },
    ]);
  });

  test("a request with no session gets 401", async () => {
    const res = await t.anonymous().get("/api/me");
    expect(res.status).toBe(401);
  });
});

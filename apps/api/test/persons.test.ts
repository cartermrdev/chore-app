import { describe, expect, test } from "bun:test";
import { useTestApp } from "./harness";

describe("GET /api/households/:householdId/persons", () => {
  const t = useTestApp();

  test("every Person in the Household sees its current Persons with their Roles", async () => {
    const { person, household } = await t.seed({ adminName: "Alex" });
    const sam = await t.addPerson(household.id, { displayName: "Sam", role: "standard" });
    const gone = await t.addPerson(household.id, { displayName: "Gone" });
    const admin = await t.signIn(person.id);
    expect((await admin.delete(`/api/households/${household.id}/persons/${gone.id}`)).status).toBe(204);
    const standard = await t.signIn(sam.id);

    const res = await standard.get(`/api/households/${household.id}/persons`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      persons: [
        { id: person.id, displayName: "Alex", role: "admin" },
        { id: sam.id, displayName: "Sam", role: "standard" },
      ],
    });
  });

  test("outsiders get 404", async () => {
    const { household } = await t.seed();
    const outsider = await t.signIn((await t.seed()).person.id);
    expect((await outsider.get(`/api/households/${household.id}/persons`)).status).toBe(404);
  });
});

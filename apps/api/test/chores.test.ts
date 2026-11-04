import { describe, expect, test } from "bun:test";
import { useTestApp } from "./harness";

const everyNDays = (n: number, startDate?: string) => ({
  kind: "fixed",
  ...(startDate ? { startDate } : {}),
  rule: { type: "every_n_days", n },
});

describe("creating Chores", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });

  test("an Admin creates a Chore with an every-N-days Fixed Schedule", async () => {
    const { person, household } = await t.seed();
    const admin = await t.signIn(person.id);

    const res = await admin.post(`/api/households/${household.id}/chores`, {
      name: "Empty the dishwasher",
      schedule: everyNDays(2),
    });

    expect(res.status).toBe(201);
    const chore = await res.json();
    expect(chore).toMatchObject({
      id: expect.any(String),
      name: "Empty the dishwasher",
      schedule: { kind: "fixed", startDate: "2026-03-01", rule: { type: "every_n_days", n: 2 } },
    });

    const list = await (await admin.get(`/api/households/${household.id}/chores`)).json();
    expect(list.chores.map((c: any) => c.name)).toEqual(["Empty the dishwasher"]);
  });

  test("a Standard Person cannot create a Chore", async () => {
    const { household } = await t.seed();
    const sam = await t.signIn((await t.addPerson(household.id, { role: "standard" })).id);

    const res = await sam.post(`/api/households/${household.id}/chores`, {
      name: "Bins",
      schedule: everyNDays(1),
    });

    expect(res.status).toBe(403);
    const list = await (await sam.get(`/api/households/${household.id}/chores`)).json();
    expect(list.chores).toEqual([]);
  });

  test("an invalid Schedule is rejected", async () => {
    const { person, household } = await t.seed();
    const admin = await t.signIn(person.id);

    for (const schedule of [undefined, everyNDays(0), everyNDays(1.5), { kind: "fixed", rule: { type: "nope" } }]) {
      const res = await admin.post(`/api/households/${household.id}/chores`, { name: "X", schedule });
      expect(res.status).toBe(400);
    }
    const res = await admin.post(`/api/households/${household.id}/chores`, { name: " ", schedule: everyNDays(1) });
    expect(res.status).toBe(400);
  });

  test("a Person outside the Household sees nothing and cannot create Chores", async () => {
    const { household } = await t.seed();
    const other = await t.seed();
    const outsider = await t.signIn(other.person.id);

    expect((await outsider.get(`/api/households/${household.id}/chores`)).status).toBe(404);
    const res = await outsider.post(`/api/households/${household.id}/chores`, { name: "X", schedule: everyNDays(1) });
    expect(res.status).toBe(404);
  });
});

describe("Occurrences and the chore list", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });

  async function adminWithChore(n: number, startDate?: string) {
    const { person, household } = await t.seed({ timeZone: "Europe/London" });
    const admin = await t.signIn(person.id);
    const res = await admin.post(`/api/households/${household.id}/chores`, { name: "Dishes", schedule: everyNDays(n, startDate) });
    const chore = await res.json();
    return { admin, household, chore, base: `/api/households/${household.id}/chores` };
  }

  test("a new daily Chore is Open and due by the end of today", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const { admin, base } = await adminWithChore(1);

    const { chores } = await (await admin.get(base)).json();

    expect(chores[0]).toMatchObject({
      name: "Dishes",
      currentOccurrence: { dueDate: "2026-03-01", status: "open", completion: null },
      nextDue: { dueDate: "2026-03-01", dueTime: "2026-03-02T00:00:00.000Z" },
    });
  });

  test("a Chore whose start date is in the future has no current Occurrence and shows when it is first due", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const { admin, base } = await adminWithChore(3, "2026-03-05");

    const { chores } = await (await admin.get(base)).json();

    expect(chores[0].currentOccurrence).toBeNull();
    expect(chores[0].nextDue).toEqual({ dueDate: "2026-03-05", dueTime: "2026-03-06T00:00:00.000Z" });
  });

  test("Occurrences are stored once each, however often and however concurrently they are read", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const { admin, base, chore } = await adminWithChore(1);
    t.clock.set("2026-03-04T09:00:00Z");

    const reads = await Promise.all([1, 2, 3, 4, 5].map(() => admin.get(`${base}/${chore.id}`)));
    for (const r of reads) expect(r.status).toBe(200);
    const bodies = await Promise.all(reads.map((r) => r.json()));
    const again = await (await admin.get(`${base}/${chore.id}`)).json();

    const dueDates = again.occurrences.map((o: any) => o.dueDate);
    expect(dueDates).toEqual(["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04"]);
    for (const b of bodies) expect(b.occurrences.map((o: any) => o.id)).toEqual(again.occurrences.map((o: any) => o.id));
  });

  test("when a Window closes without a Completion the Occurrence becomes Missed", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const { admin, base, chore } = await adminWithChore(2);

    t.clock.set("2026-03-02T23:59:59Z"); // still inside the 2-day Window (late, not Missed)
    let detail = await (await admin.get(`${base}/${chore.id}`)).json();
    expect(detail.occurrences.map((o: any) => [o.dueDate, o.status])).toEqual([["2026-03-01", "open"]]);

    t.clock.set("2026-03-03T00:00:00Z"); // the next Window opens: this one closes
    detail = await (await admin.get(`${base}/${chore.id}`)).json();
    expect(detail.occurrences.map((o: any) => [o.dueDate, o.status])).toEqual([
      ["2026-03-01", "missed"],
      ["2026-03-03", "open"],
    ]);
    const { chores } = await (await admin.get(base)).json();
    expect(chores[0].currentOccurrence).toMatchObject({ dueDate: "2026-03-03", status: "open" });
  });

  test("an unknown Chore is 404", async () => {
    const { admin, base } = await adminWithChore(1);
    expect((await admin.get(`${base}/00000000-0000-0000-0000-000000000000`)).status).toBe(404);
    expect((await admin.get(`${base}/not-a-uuid`)).status).toBe(404);
  });
});

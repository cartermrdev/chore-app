import { describe, expect, test } from "bun:test";
import { useTestApp, type TestClient } from "./harness";

describe("Interval and One-off Schedules", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });

  /** A Household (Europe/London) with an Admin, a Standard Person and one Chore with the given Schedule. */
  async function household(schedule: unknown) {
    const { person, household } = await t.seed({ timeZone: "Europe/London", adminName: "Alex" });
    const admin = await t.signIn(person.id);
    const sam = await t.addPerson(household.id, { displayName: "Sam", role: "standard" });
    const standard = await t.signIn(sam.id);
    const base = `/api/households/${household.id}/chores`;
    const created = await admin.post(base, { name: "Filter", schedule });
    const chore = await created.json();
    const complete = (client: TestClient, idempotencyKey: string) =>
      client.post(`${base}/${chore.id}/complete`, { idempotencyKey });
    const detail = async () => (await admin.get(`${base}/${chore.id}`)).json();
    return { admin, standard, sam, base, created, chore, complete, detail };
  }

  test("an Admin creates an Interval Chore; its first Occurrence is due on the start date", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household({ kind: "interval", periodDays: 30 });

    expect(h.created.status).toBe(201);
    expect(h.chore.schedule).toEqual({ kind: "interval", startDate: "2026-03-01", periodDays: 30 });
    expect(await h.detail()).toMatchObject({
      currentOccurrence: { dueDate: "2026-03-01", status: "open", windowEnd: null },
      nextDue: { dueDate: "2026-03-01" },
    });
  });

  test("an Interval Occurrence stays Open past its due date, and completing it makes the next one due a period later", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household({ kind: "interval", periodDays: 30 });
    t.clock.set("2026-03-05T10:00:00Z");
    expect(await h.detail()).toMatchObject({ currentOccurrence: { dueDate: "2026-03-01", status: "open" } });

    const res = await (await h.complete(h.standard, "k1")).json();

    expect(res).toMatchObject({
      outcome: "completed",
      completion: { dueDate: "2026-03-01", late: true, early: false },
      nextDue: { dueDate: "2026-04-04", dueTime: "2026-04-04T23:00:00.000Z" },
    });
    t.clock.set("2026-04-04T08:00:00Z");
    const detail = await h.detail();
    expect(detail.occurrences.map((o: any) => [o.dueDate, o.status])).toEqual([
      ["2026-03-01", "completed"],
      ["2026-04-04", "open"],
    ]);
  });

  test("a One-off Occurrence stays Open past its due date, and once completed the Chore has no further Occurrences", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household({ kind: "one_off", dueDate: "2026-03-03" });
    expect(h.created.status).toBe(201);
    expect(await h.detail()).toMatchObject({ currentOccurrence: null, nextDue: { dueDate: "2026-03-03" } });

    t.clock.set("2026-04-20T09:00:00Z");
    expect(await h.detail()).toMatchObject({
      currentOccurrence: { dueDate: "2026-03-03", status: "open", windowEnd: null },
    });
    const res = await (await h.complete(h.standard, "k1")).json();
    expect(res).toMatchObject({ outcome: "completed", completion: { late: true }, nextDue: null });

    t.clock.set("2026-06-20T09:00:00Z");
    const detail = await h.detail();
    expect(detail.occurrences.map((o: any) => o.status)).toEqual(["completed"]);
    expect(detail.nextDue).toBeNull();
  });

  test("an Excused Interval Occurrence restarts the period from the Excuse", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household({ kind: "interval", periodDays: 10 });
    const occurrenceId = (await h.detail()).currentOccurrence.id;
    t.clock.set("2026-03-04T09:00:00Z");

    const excused = await h.admin.post(`/api/occurrences/${occurrenceId}/excuse`, { note: "Away" });

    expect(excused.status).toBe(200);
    expect(await h.detail()).toMatchObject({ nextDue: { dueDate: "2026-03-14" } });
  });

  test("Interval Schedules are validated", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household({ kind: "interval", periodDays: 0 });
    expect(h.created.status).toBe(400);
  });
});

import { describe, expect, test } from "bun:test";
import { useTestApp, type TestClient } from "./harness";

const daily = { kind: "fixed", rule: { type: "every_n_days", n: 1 } };

describe("History", () => {
  // Winter in London, so local time is UTC.
  const t = useTestApp({ now: "2026-01-05T09:00:00Z" });

  /** Admin Alex, Standard Sam and Kim; "Dishes" is daily and assigned to Sam. */
  async function household() {
    t.clock.set("2026-01-05T09:00:00Z");
    const { person, household } = await t.seed({ timeZone: "Europe/London", adminName: "Alex" });
    const admin = await t.signIn(person.id);
    const sam = await t.addPerson(household.id, { displayName: "Sam", role: "standard" });
    const standard = await t.signIn(sam.id);
    const kim = await t.addPerson(household.id, { displayName: "Kim", role: "standard" });
    const other = await t.signIn(kim.id);
    const base = `/api/households/${household.id}`;
    const chore = await (
      await admin.post(`${base}/chores`, { name: "Dishes", schedule: daily, assigneeId: sam.id })
    ).json();
    const complete = async (client: TestClient, key: string, extra: object = {}, choreId: string = chore.id) => {
      const body = await (await client.post(`${base}/chores/${choreId}/complete`, { idempotencyKey: key, ...extra })).json();
      expect(body.outcome).toBe("completed");
      return body.completion as { id: string; occurrenceId: string };
    };
    const personHistory = (client: TestClient, personId: string, from: string, to: string) =>
      client.get(`${base}/history/persons/${personId}?from=${from}&to=${to}`);
    const householdHistory = (client: TestClient, from: string, to: string) =>
      client.get(`${base}/history?from=${from}&to=${to}`);
    return {
      admin, standard, other, adminPerson: person, sam, kim, household, base, chore,
      complete, personHistory, householdHistory,
    };
  }

  describe("per-Person history", () => {
    test("an assigned Occurrence completed by its Assignee before the Due Time is on time", async () => {
      const h = await household();
      await h.complete(h.standard, "k1");

      const res = await h.personHistory(h.admin, h.sam.id, "2026-01-05", "2026-01-05");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.person).toEqual({ id: h.sam.id, displayName: "Sam" });
      expect(body.assigned).toMatchObject([
        {
          chore: { id: h.chore.id, name: "Dishes" },
          dueDate: "2026-01-05",
          timeSlot: null,
          outcome: "on_time",
          completion: { completer: { displayName: "Sam" }, late: false },
          skip: null,
        },
      ]);
    });

    test("each assigned Occurrence gets exactly one outcome: on time, Late, by someone else, Missed or Skipped", async () => {
      const h = await household();
      // Late is covered separately: a daily day-level Window closes when Late would begin.
      await h.complete(h.standard, "d5"); // 01-05 on time
      t.clock.set("2026-01-06T10:00:00Z");
      await h.complete(h.other, "d6"); // 01-06 by Kim
      t.clock.set("2026-01-07T10:00:00Z");
      const excused = await (await h.admin.get(`${h.base}/chores/${h.chore.id}`)).json();
      const occ7 = excused.currentOccurrence.id;
      expect((await h.admin.post(`/api/occurrences/${occ7}/excuse`, { note: "Sick" })).status).toBe(200);
      // 01-08 left alone -> Missed once 01-09 starts. 01-09 still Open -> not listed.
      t.clock.set("2026-01-09T10:00:00Z");

      const body = await (await h.personHistory(h.standard, h.sam.id, "2026-01-01", "2026-01-31")).json();

      expect(body.assigned.map((a: any) => [a.dueDate, a.outcome])).toEqual([
        ["2026-01-05", "on_time"],
        ["2026-01-06", "by_someone_else"],
        ["2026-01-07", "skipped"],
        ["2026-01-08", "missed"],
      ]);
      expect(body.assigned[1].completion).toMatchObject({ completer: { displayName: "Kim" } });
      expect(body.assigned[2].skip).toMatchObject({ reason: "excused", note: "Sick", excusedBy: { displayName: "Alex" } });
      expect(body.assigned[3]).toMatchObject({ completion: null, skip: null });
    });

    test("a Completion after the Due Time is Late", async () => {
      const h = await household();
      const weekly = { kind: "fixed", rule: { type: "every_n_days", n: 7 } };
      const chore = await (
        await h.admin.post(`${h.base}/chores`, { name: "Bins", schedule: weekly, assigneeId: h.sam.id })
      ).json();
      t.clock.set("2026-01-07T10:00:00Z");
      await h.complete(h.standard, "bins", {}, chore.id);

      const body = await (await h.personHistory(h.admin, h.sam.id, "2026-01-05", "2026-01-05")).json();

      expect(body.assigned.find((a: any) => a.chore.name === "Bins")).toMatchObject({
        outcome: "late",
        completion: { late: true },
      });
    });

    test("Skipped entries from a Pause show the Pause", async () => {
      const h = await household();
      const pause = await (
        await h.admin.post(`${h.base}/pauses`, { startDate: "2026-01-06", endDate: "2026-01-07" })
      ).json();
      t.clock.set("2026-01-08T10:00:00Z");

      const body = await (await h.personHistory(h.standard, h.sam.id, "2026-01-06", "2026-01-07")).json();

      expect(body.assigned).toMatchObject([
        { dueDate: "2026-01-06", outcome: "skipped", skip: { reason: "pause", pause: { id: pause.id, choreId: null, startDate: "2026-01-06", endDate: "2026-01-07" } } },
        { dueDate: "2026-01-07", outcome: "skipped", skip: { reason: "pause" } },
      ]);
    });

    test("it lists the Person's Completions on unassigned Occurrences and on ones assigned to others", async () => {
      const h = await household();
      const unassigned = await (await h.admin.post(`${h.base}/chores`, { name: "Sweep", schedule: daily })).json();
      const kims = await (
        await h.admin.post(`${h.base}/chores`, { name: "Laundry", schedule: daily, assigneeId: h.kim.id })
      ).json();
      await h.complete(h.standard, "own");
      await h.complete(h.standard, "sweep", {}, unassigned.id);
      t.clock.advance({ minutes: 1 });
      await h.complete(h.standard, "laundry", {}, kims.id);
      const voided = await (await h.admin.post(`${h.base}/chores`, { name: "Mop", schedule: daily })).json();
      const mop = await h.complete(h.standard, "mop", {}, voided.id);
      expect((await h.admin.post(`/api/completions/${mop.id}/void`)).status).toBe(200);

      const body = await (await h.personHistory(h.other, h.sam.id, "2026-01-05", "2026-01-05")).json();

      expect(body.otherCompletions.map((c: any) => [c.chore.name, c.occurrence.assignee?.displayName ?? null])).toEqual([
        ["Laundry", "Kim"],
        ["Sweep", null],
      ]);
      expect(body.assigned.map((a: any) => a.chore.name)).toEqual(["Dishes"]);
    });

    test("Kim's history shows her Occurrence completed by someone else", async () => {
      const h = await household();
      const kims = await (
        await h.admin.post(`${h.base}/chores`, { name: "Laundry", schedule: daily, assigneeId: h.kim.id })
      ).json();
      await h.complete(h.standard, "laundry", {}, kims.id);

      const body = await (await h.personHistory(h.other, h.kim.id, "2026-01-05", "2026-01-05")).json();

      expect(body.assigned).toMatchObject([{ chore: { name: "Laundry" }, outcome: "by_someone_else", completion: { completer: { displayName: "Sam" } } }]);
      expect(body.otherCompletions).toEqual([]);
    });

    test("an ended Membership keeps its Completions under the Person's name", async () => {
      const h = await household();
      await h.complete(h.standard, "k1");
      expect((await h.admin.delete(`${h.base}/persons/${h.sam.id}`)).status).toBe(204);

      const person = await (await h.personHistory(h.admin, h.sam.id, "2026-01-05", "2026-01-05")).json();
      const all = await (await h.householdHistory(h.other, "2026-01-05", "2026-01-05")).json();

      expect(person).toMatchObject({ person: { displayName: "Sam" }, assigned: [{ outcome: "on_time" }] });
      expect(all.completions).toMatchObject([{ completer: { id: h.sam.id, displayName: "Sam" } }]);
    });

    test("the Person picker lists everyone who ever had a Membership, ended ones included, without granting them access", async () => {
      const h = await household();
      expect((await h.admin.delete(`${h.base}/persons/${h.sam.id}`)).status).toBe(204);
      await t.seed({ adminName: "Stranger" });

      const res = await h.other.get(`${h.base}/history/persons`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        persons: [
          { id: h.adminPerson.id, displayName: "Alex", current: true },
          { id: h.kim.id, displayName: "Kim", current: true },
          { id: h.sam.id, displayName: "Sam", current: false },
        ],
      });
      expect((await h.standard.get(`${h.base}/history/persons`)).status).toBe(404);
    });

    test("a Person who never belonged to the Household gets 404", async () => {
      const h = await household();
      const elsewhere = await t.seed({ adminName: "Stranger" });

      for (const id of [elsewhere.person.id, "not-a-uuid"]) {
        expect((await h.personHistory(h.admin, id, "2026-01-05", "2026-01-05")).status).toBe(404);
      }
    });
  });

  describe("Household history", () => {
    test("shows Method, Tag, Completer, Recorder, time, Late and voided state, newest first", async () => {
      const h = await household();
      const tag = await (await h.admin.post(`${h.base}/tags`, { choreId: h.chore.id })).json();
      t.clock.set("2026-01-05T10:00:00Z");
      const scan = await (await h.standard.post(`/api/scan/${tag.id}`, { idempotencyKey: "s1" })).json();
      expect(scan.outcome).toBe("completed");
      expect((await h.admin.post(`/api/completions/${scan.completion.id}/void`)).status).toBe(200);
      t.clock.set("2026-01-05T11:00:00Z");
      await h.complete(h.admin, "behalf", { completerId: h.kim.id });

      const res = await h.householdHistory(h.standard, "2026-01-05", "2026-01-05");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ from: "2026-01-05", to: "2026-01-05" });
      expect(body.completions).toMatchObject([
        {
          chore: { name: "Dishes" },
          method: "manual",
          tagId: null,
          completer: { id: h.kim.id, displayName: "Kim" },
          recorder: { id: h.adminPerson.id, displayName: "Alex" },
          completedAt: "2026-01-05T11:00:00.000Z",
          late: false,
          voided: null,
        },
        {
          method: "nfc",
          tagId: tag.id,
          completer: { displayName: "Sam" },
          recorder: { displayName: "Sam" },
          completedAt: "2026-01-05T10:00:00.000Z",
          late: false,
          voided: { by: { displayName: "Alex" } },
        },
      ]);
    });

    test("the range uses local dates in the Household zone and leaves out other days", async () => {
      const h = await household();
      await h.complete(h.standard, "d5");
      t.clock.set("2026-01-06T10:00:00Z");
      await h.complete(h.standard, "d6");

      const body = await (await h.householdHistory(h.admin, "2026-01-06", "2026-01-06")).json();

      expect(body.completions.map((c: any) => c.occurrence.dueDate)).toEqual(["2026-01-06"]);
    });

    test("a malformed or backwards range is rejected", async () => {
      const h = await household();
      for (const [from, to] of [["2026-01-06", "2026-01-05"], ["nope", "2026-01-05"], ["2025-01-01", "2026-01-05"]]) {
        const res = await h.householdHistory(h.admin, from!, to!);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid_range" });
      }
    });
  });

  test("Admins and Standard Persons can see both histories; outsiders and ended Memberships cannot", async () => {
    const h = await household();
    const outsider = await t.signIn((await t.seed({ adminName: "Stranger" })).person.id);
    const left = await t.addPerson(h.household.id, { displayName: "Lee" });
    const leftClient = await t.signIn(left.id);
    expect((await h.admin.delete(`${h.base}/persons/${left.id}`)).status).toBe(204);

    for (const client of [h.admin, h.standard]) {
      expect((await h.householdHistory(client, "2026-01-05", "2026-01-05")).status).toBe(200);
      expect((await h.personHistory(client, h.kim.id, "2026-01-05", "2026-01-05")).status).toBe(200);
    }
    for (const client of [outsider, leftClient]) {
      expect((await h.householdHistory(client, "2026-01-05", "2026-01-05")).status).toBe(404);
      expect((await h.personHistory(client, h.sam.id, "2026-01-05", "2026-01-05")).status).toBe(404);
    }
    expect((await h.householdHistory(t.anonymous(), "2026-01-05", "2026-01-05")).status).toBe(401);
  });
});

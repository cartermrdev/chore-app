import { describe, expect, test } from "bun:test";
import { useTestApp, type TestClient } from "./harness";

const everyNDays = (n: number) => ({ kind: "fixed", rule: { type: "every_n_days", n } });

describe("Corrections", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });

  /** Europe/London Household: Admin Alex, Standard Sam and Kim, one every-N-days Chore "Dishes". */
  async function household(n = 1) {
    const { person, household } = await t.seed({ timeZone: "Europe/London", adminName: "Alex" });
    const admin = await t.signIn(person.id);
    const sam = await t.addPerson(household.id, { displayName: "Sam", role: "standard" });
    const standard = await t.signIn(sam.id);
    const kim = await t.addPerson(household.id, { displayName: "Kim", role: "standard" });
    const other = await t.signIn(kim.id);
    const base = `/api/households/${household.id}/chores`;
    const chore = await (await admin.post(base, { name: "Dishes", schedule: everyNDays(n) })).json();
    const complete = async (client: TestClient, idempotencyKey: string, extra: object = {}) =>
      client.post(`${base}/${chore.id}/complete`, { idempotencyKey, ...extra });
    const completeOk = async (client: TestClient, key: string) => {
      const body = await (await complete(client, key)).json();
      expect(body.outcome).toBe("completed");
      return body.completion as { id: string; occurrenceId: string };
    };
    const detail = async (client: TestClient = admin) => (await client.get(`${base}/${chore.id}`)).json();
    const undo = (client: TestClient, completionId: string) => client.post(`/api/completions/${completionId}/undo`);
    const voidIt = (client: TestClient, completionId: string) => client.post(`/api/completions/${completionId}/void`);
    const excuse = (client: TestClient, occurrenceId: string, note?: unknown) =>
      client.post(`/api/occurrences/${occurrenceId}/excuse`, note === undefined ? {} : { note });
    return {
      admin, standard, other, adminPerson: person, sam, kim, household, base, chore,
      complete, completeOk, detail, undo, voidIt, excuse,
    };
  }

  describe("Undo", () => {
    test("the Completer can Undo within 5 minutes, which reopens the Occurrence", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const completion = await h.completeOk(h.standard, "k1");

      t.clock.advance({ minutes: 5 });
      const res = await h.undo(h.standard, completion.id);

      expect(res.status).toBe(200);
      const { occurrences } = await h.detail();
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]).toMatchObject({ status: "open", completion: null });
    });

    test("after Undo the Occurrence can be completed again", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const first = await h.completeOk(h.standard, "k1");
      expect((await h.undo(h.standard, first.id)).status).toBe(200);

      t.clock.advance({ minutes: 10 });
      const again = await h.completeOk(h.other, "k2");

      expect(again.occurrenceId).toBe(first.occurrenceId);
      expect(again.id).not.toBe(first.id);
      const { occurrences } = await h.detail();
      expect(occurrences[0]).toMatchObject({ status: "completed", completion: { id: again.id, completer: { displayName: "Kim" } } });
    });

    test("Undo is rejected after 5 minutes and the Completion stands", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const completion = await h.completeOk(h.standard, "k1");

      t.clock.advance({ minutes: 5, seconds: 1 });
      const res = await h.undo(h.standard, completion.id);

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "undo_expired" });
      const { occurrences } = await h.detail();
      expect(occurrences[0]).toMatchObject({ status: "completed", completion: { id: completion.id } });
    });

    test("nobody but the Completer can Undo, not even an Admin", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const completion = await h.completeOk(h.standard, "k1");

      for (const client of [h.other, h.admin]) {
        const res = await client.post(`/api/completions/${completion.id}/undo`);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "forbidden" });
      }
      const { occurrences } = await h.detail();
      expect(occurrences[0]).toMatchObject({ status: "completed", completion: { id: completion.id } });
    });

    test("an Undo after the Window has closed leaves the Occurrence Missed", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      t.clock.set("2026-03-01T23:58:00Z");
      const completion = await h.completeOk(h.standard, "k1");

      t.clock.set("2026-03-02T00:01:00Z"); // the 03-02 Window has opened, 03-01's has closed
      expect((await h.undo(h.standard, completion.id)).status).toBe(200);

      const { occurrences } = await h.detail();
      expect(occurrences.map((o: any) => [o.dueDate, o.status])).toEqual([
        ["2026-03-01", "missed"],
        ["2026-03-02", "open"],
      ]);
    });

    test("Undo twice is rejected the second time", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const completion = await h.completeOk(h.standard, "k1");
      expect((await h.undo(h.standard, completion.id)).status).toBe(200);

      const res = await h.undo(h.standard, completion.id);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "already_voided" });
    });

    test("a Person outside the Household gets 404", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const completion = await h.completeOk(h.standard, "k1");
      const outsider = await t.signIn((await t.seed({ adminName: "Out" })).person.id);

      expect((await outsider.post(`/api/completions/${completion.id}/undo`)).status).toBe(404);
      expect((await outsider.post(`/api/completions/${completion.id}/void`)).status).toBe(404);
      expect((await outsider.post(`/api/occurrences/${completion.occurrenceId}/excuse`, { note: "x" })).status).toBe(404);
      expect((await outsider.post(`/api/completions/not-a-uuid/undo`)).status).toBe(404);
      expect((await t.anonymous().post(`/api/completions/${completion.id}/undo`)).status).toBe(401);
    });

    test("an undone Completion stays in history, voided by the Completer", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const completion = await h.completeOk(h.standard, "k1");
      t.clock.set("2026-03-01T09:02:00Z");
      await h.undo(h.standard, completion.id);

      const { occurrences } = await h.detail(h.standard);
      expect(occurrences[0].voidedCompletions).toEqual([
        expect.objectContaining({
          id: completion.id,
          completer: { id: h.sam.id, displayName: "Sam" },
          voidedAt: "2026-03-01T09:02:00.000Z",
          voidedBy: { id: h.sam.id, displayName: "Sam" },
        }),
      ]);
    });
  });

  describe("Void", () => {
    test("an Admin can Void any Completion at any time; it stays in history marked voided", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household(3);
      const completion = await h.completeOk(h.standard, "k1");

      t.clock.set("2026-03-02T12:00:00Z"); // a day later, Window (3 days) still open
      const res = await h.voidIt(h.admin, completion.id);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ occurrence: { id: completion.occurrenceId, status: "open" } });
      const { occurrences } = await h.detail(h.standard);
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]).toMatchObject({
        status: "open",
        completion: null,
        voidedCompletions: [
          {
            id: completion.id,
            completer: { id: h.sam.id, displayName: "Sam" },
            recorder: { id: h.sam.id, displayName: "Sam" },
            method: "manual",
            completedAt: "2026-03-01T09:00:00.000Z",
            late: false,
            voidedAt: "2026-03-02T12:00:00.000Z",
            voidedBy: { id: h.adminPerson.id, displayName: "Alex" },
          },
        ],
      });

      // ...and it can be completed again.
      const again = await h.completeOk(h.standard, "k2");
      expect(again.occurrenceId).toBe(completion.occurrenceId);
    });

    test("Voiding after the Window has closed makes the Occurrence Missed", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const completion = await h.completeOk(h.standard, "k1");

      t.clock.set("2026-03-05T09:00:00Z");
      expect(await (await h.voidIt(h.admin, completion.id)).json()).toEqual({
        occurrence: { id: completion.occurrenceId, status: "missed" },
      });
      const { occurrences } = await h.detail();
      expect(occurrences[0]).toMatchObject({ dueDate: "2026-03-01", status: "missed", completion: null });
    });

    test("Standard Persons cannot Void, even their own Completion", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const completion = await h.completeOk(h.standard, "k1");

      for (const client of [h.standard, h.other]) {
        const res = await h.voidIt(client, completion.id);
        expect(res.status).toBe(403);
      }
      const { occurrences } = await h.detail();
      expect(occurrences[0]).toMatchObject({ status: "completed", completion: { id: completion.id }, voidedCompletions: [] });
    });

    test("a Completion cannot be Voided twice", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const completion = await h.completeOk(h.standard, "k1");
      await h.voidIt(h.admin, completion.id);
      const res = await h.voidIt(h.admin, completion.id);
      expect(res.status).toBe(409);
    });

    test("concurrent Voids and Undos withdraw the Completion exactly once", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const completion = await h.completeOk(h.standard, "k1");

      const results = await Promise.all([
        h.voidIt(h.admin, completion.id),
        h.undo(h.standard, completion.id),
        h.voidIt(h.admin, completion.id),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      const { occurrences } = await h.detail();
      expect(occurrences[0].voidedCompletions).toHaveLength(1);
    });
  });

  describe("Recording on someone's behalf", () => {
    test("an Admin records a Manual Completion with another Person as the Completer", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();

      const res = await h.complete(h.admin, "k1", { completerId: h.sam.id });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        outcome: "completed",
        completion: {
          completer: { id: h.sam.id, displayName: "Sam" },
          recorder: { id: h.adminPerson.id, displayName: "Alex" },
          method: "manual",
        },
      });
      const { occurrences } = await h.detail(h.standard);
      expect(occurrences[0].completion).toMatchObject({
        completer: { displayName: "Sam" },
        recorder: { displayName: "Alex" },
      });
    });

    test("an Admin can credit another Admin", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const bo = await t.addPerson(h.household.id, { displayName: "Bo", role: "admin" });

      const body = await (await h.complete(h.admin, "k1", { completerId: bo.id })).json();
      expect(body.completion).toMatchObject({ completer: { displayName: "Bo" }, recorder: { displayName: "Alex" } });
    });

    test("a Person's own Manual and NFC Completions have the same Completer and Recorder", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const own = await (await h.complete(h.standard, "k1", { completerId: h.sam.id })).json();
      expect(own.completion.completer).toEqual(own.completion.recorder);
      expect(own.completion.completer.id).toBe(h.sam.id);

      t.clock.set("2026-03-02T09:00:00Z");
      const tag = await (await h.admin.post(`/api/households/${h.household.id}/tags`, { choreId: h.chore.id })).json();
      const scan = await (await h.other.post(`/api/scan/${tag.id}`, { idempotencyKey: "s1" })).json();
      expect(scan.outcome).toBe("completed");
      expect(scan.completion.completer).toEqual({ id: h.kim.id, displayName: "Kim" });
      expect(scan.completion.recorder).toEqual(scan.completion.completer);
    });

    test("Standard Persons cannot record a Completion on someone else's behalf", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();

      const res = await h.complete(h.standard, "k1", { completerId: h.kim.id });

      expect(res.status).toBe(403);
      expect((await h.detail()).occurrences[0]).toMatchObject({ status: "open", completion: null });
    });

    test("the Completer must be a current Person in the Household", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const outsider = (await t.seed({ adminName: "Out" })).person;

      for (const completerId of [outsider.id, "not-a-uuid", 7]) {
        const res = await h.complete(h.admin, `k-${completerId}`, { completerId });
        expect(res.status).toBe(400);
      }
      expect((await h.detail()).occurrences[0]).toMatchObject({ status: "open", completion: null });
    });
  });

  describe("Excuse", () => {
    test("an Admin can Excuse an Open Occurrence with a note, which makes it Skipped", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const [open] = (await h.detail()).occurrences;

      t.clock.set("2026-03-01T10:00:00Z");
      const res = await h.excuse(h.admin, open.id, "  Sam is ill  ");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ occurrence: { id: open.id, status: "skipped" } });
      const { occurrences } = await h.detail(h.standard);
      expect(occurrences[0]).toMatchObject({
        status: "skipped",
        completion: null,
        excuse: {
          note: "Sam is ill",
          excusedAt: "2026-03-01T10:00:00.000Z",
          excusedBy: { id: h.adminPerson.id, displayName: "Alex" },
        },
      });
      // A Skipped Occurrence is not due, so completing finds nothing.
      expect((await (await h.complete(h.standard, "k1")).json()).outcome).toBe("nothing_due");
    });

    test("an Admin can Excuse a Missed Occurrence", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      t.clock.set("2026-03-02T09:00:00Z");
      const [missed] = (await h.detail()).occurrences;
      expect(missed.status).toBe("missed");

      expect((await h.excuse(h.admin, missed.id, "Away")).status).toBe(200);

      const { occurrences } = await h.detail();
      expect(occurrences.map((o: any) => o.status)).toEqual(["skipped", "open"]);
      expect(occurrences[0].excuse.note).toBe("Away");
      expect(occurrences[1].excuse).toBeNull();
    });

    test("a note is required", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const [open] = (await h.detail()).occurrences;

      for (const note of [undefined, "", "   ", 42, "x".repeat(501)]) {
        const res = await h.excuse(h.admin, open.id, note);
        expect(res.status).toBe(400);
      }
      expect((await h.detail()).occurrences[0]).toMatchObject({ status: "open", excuse: null });
    });

    test("a Completed or already Skipped Occurrence cannot be Excused", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const completion = await h.completeOk(h.standard, "k1");

      expect((await h.excuse(h.admin, completion.occurrenceId, "late")).status).toBe(409);

      await h.voidIt(h.admin, completion.id);
      expect((await h.excuse(h.admin, completion.occurrenceId, "first")).status).toBe(200);
      const res = await h.excuse(h.admin, completion.occurrenceId, "second");
      expect(res.status).toBe(409);
      expect((await h.detail()).occurrences[0].excuse.note).toBe("first");
    });

    test("Excusals and voided Completions are history: the Chore can't be hard-deleted", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const excused = await household();
      const [open] = (await excused.detail()).occurrences;
      await excused.excuse(excused.admin, open.id, "Ill");
      expect((await excused.admin.delete(`${excused.base}/${excused.chore.id}`)).status).toBe(409);

      const voided = await household();
      const completion = await voided.completeOk(voided.standard, "k1");
      await voided.undo(voided.standard, completion.id);
      expect((await voided.admin.delete(`${voided.base}/${voided.chore.id}`)).status).toBe(409);
      expect((await voided.detail()).occurrences[0].voidedCompletions).toHaveLength(1);
    });

    test("Standard Persons cannot Excuse", async () => {
      t.clock.set("2026-03-01T09:00:00Z");
      const h = await household();
      const [open] = (await h.detail()).occurrences;

      const res = await h.excuse(h.standard, open.id, "please");
      expect(res.status).toBe(403);
      expect((await h.detail()).occurrences[0]).toMatchObject({ status: "open", excuse: null });
    });
  });
});

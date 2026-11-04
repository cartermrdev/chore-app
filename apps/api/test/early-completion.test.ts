import { describe, expect, test } from "bun:test";
import { useTestApp, type TestClient } from "./harness";

const everyNDays = (n: number) => ({ kind: "fixed", rule: { type: "every_n_days", n } });

describe("Early Completion in the app", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });

  /** A Household (Europe/London) with an Admin, a Standard Person and one Chore. */
  async function household(schedule: unknown) {
    const { person, household } = await t.seed({ timeZone: "Europe/London", adminName: "Alex" });
    const admin = await t.signIn(person.id);
    const sam = await t.addPerson(household.id, { displayName: "Sam", role: "standard" });
    const standard = await t.signIn(sam.id);
    const base = `/api/households/${household.id}/chores`;
    const chore = await (await admin.post(base, { name: "Filter", schedule })).json();
    const complete = (client: TestClient, idempotencyKey: string) =>
      client.post(`${base}/${chore.id}/complete`, { idempotencyKey });
    const completeEarly = (client: TestClient, idempotencyKey: string, dueDate: string) =>
      client.post(`${base}/${chore.id}/complete-early`, { idempotencyKey, dueDate });
    const detail = async () => (await admin.get(`${base}/${chore.id}`)).json();
    return { admin, standard, sam, base, chore, complete, completeEarly, detail };
  }

  test("on an Interval Chore it completes the next Occurrence early and restarts the period from that Completion", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household({ kind: "interval", periodDays: 30 });
    await h.complete(h.standard, "first");
    t.clock.set("2026-03-26T08:00:00Z"); // the filter was changed on day 25

    const res = await h.completeEarly(h.standard, "early-1", "2026-03-31");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      outcome: "completed",
      completion: {
        dueDate: "2026-03-31",
        completer: { displayName: "Sam" },
        method: "manual",
        completedAt: "2026-03-26T08:00:00.000Z",
        late: false,
        early: true,
      },
      nextDue: { dueDate: "2026-04-25" },
    });
    const detail = await h.detail();
    expect(detail.occurrences.map((o: any) => [o.dueDate, o.status, o.completion?.early])).toEqual([
      ["2026-03-01", "completed", false],
      ["2026-03-31", "completed", true],
    ]);
    expect(detail.nextDue).toMatchObject({ dueDate: "2026-04-25" });
    // The Chore's current status shows the Early Completion.
    expect(detail.currentOccurrence).toMatchObject({ dueDate: "2026-03-31", completion: { early: true } });
  });

  test("on a Fixed Chore it completes tomorrow's Occurrence, and tomorrow nothing is left to do", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household(everyNDays(1));
    await h.complete(h.standard, "today");

    const early = await (await h.completeEarly(h.standard, "early", "2026-03-02")).json();
    expect(early).toMatchObject({
      outcome: "completed",
      completion: { dueDate: "2026-03-02", early: true, late: false },
      nextDue: { dueDate: "2026-03-03" },
    });

    t.clock.set("2026-03-02T12:00:00Z");
    const tomorrow = await (await h.complete(h.admin, "tomorrow")).json();
    expect(tomorrow).toMatchObject({
      outcome: "already_completed",
      completion: { dueDate: "2026-03-02", completer: { displayName: "Sam" }, early: true },
      nextDue: { dueDate: "2026-03-03" },
    });
    expect((await h.detail()).occurrences.map((o: any) => o.status)).toEqual(["completed", "completed"]);
  });

  test("a repeated request returns the original result and records nothing new", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household({ kind: "interval", periodDays: 7 });
    await h.complete(h.standard, "first");

    const first = await (await h.completeEarly(h.standard, "same", "2026-03-08")).json();
    t.clock.set("2026-03-01T09:05:00Z");
    const again = await (await h.completeEarly(h.standard, "same", "2026-03-08")).json();

    expect(again).toEqual(first);
    expect((await h.detail()).occurrences).toHaveLength(2);
  });

  test("two people completing the same Occurrence early at once produce exactly one Completion", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household({ kind: "interval", periodDays: 7 });
    await h.complete(h.standard, "first");

    const results = await Promise.all([
      h.completeEarly(h.standard, "sam", "2026-03-08").then((r) => r.json()),
      h.completeEarly(h.admin, "alex", "2026-03-08").then((r) => r.json()),
    ]);

    expect(results.map((r) => r.outcome).sort()).toEqual(["already_completed", "completed"]);
    expect(results[0].completion.id).toBe(results[1].completion.id);
    const detail = await h.detail();
    expect(detail.occurrences.map((o: any) => [o.dueDate, o.status])).toEqual([
      ["2026-03-01", "completed"],
      ["2026-03-08", "completed"],
    ]);
    // A period after the Early Completion is 03-08 again, which is taken: the next one is the day after.
    expect(detail.nextDue).toMatchObject({ dueDate: "2026-03-09" });
  });

  test("asking for an Occurrence that is no longer the next one records nothing", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household({ kind: "interval", periodDays: 7 });
    await h.complete(h.standard, "first");

    const stale = await (await h.completeEarly(h.standard, "stale", "2026-03-20")).json();

    expect(stale).toEqual({ outcome: "nothing_due", nextDue: expect.objectContaining({ dueDate: "2026-03-08" }) });
    expect((await h.detail()).occurrences).toHaveLength(1);
  });

  test("when the Occurrence is already due it is completed as normal, not early", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household(everyNDays(1));

    const res = await (await h.completeEarly(h.standard, "k", "2026-03-01")).json();

    expect(res).toMatchObject({ outcome: "completed", completion: { dueDate: "2026-03-01", early: false } });
  });

  test("a completed One-off Chore has nothing to complete early", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household({ kind: "one_off", dueDate: "2026-03-01" });
    await h.complete(h.standard, "done");

    const res = await (await h.completeEarly(h.standard, "again", "2026-03-01")).json();

    expect(res).toMatchObject({ outcome: "already_completed", nextDue: null });
  });

  test("after an Early Completion is undone, that Occurrence is next due again and can be completed early again", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household({ kind: "interval", periodDays: 7 });
    await h.complete(h.standard, "first");
    const early = await (await h.completeEarly(h.standard, "early", "2026-03-08")).json();

    const undo = await h.standard.post(`/api/completions/${early.completion.id}/undo`, {});

    expect(undo.status).toBe(200);
    expect(await h.detail()).toMatchObject({ nextDue: { dueDate: "2026-03-08" } });
    const again = await (await h.completeEarly(h.standard, "early-again", "2026-03-08")).json();
    expect(again).toMatchObject({ outcome: "completed", completion: { dueDate: "2026-03-08", early: true } });
  });

  test("an Admin can record an Early Completion on someone else's behalf", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household({ kind: "interval", periodDays: 7 });
    await h.complete(h.standard, "first");

    const res = await (
      await h.admin.post(`${h.base}/${h.chore.id}/complete-early`, {
        idempotencyKey: "for-sam",
        dueDate: "2026-03-08",
        completerId: h.sam.id,
      })
    ).json();

    expect(res).toMatchObject({
      outcome: "completed",
      completion: { early: true, completer: { displayName: "Sam" }, recorder: { displayName: "Alex" } },
    });
  });

  test("with Time Slots, nextDue names the slot and Complete early completes that slot's Occurrence", async () => {
    t.clock.set("2026-03-01T07:00:00Z");
    const h = await household({
      ...everyNDays(1),
      slots: [
        { name: "Morning", start: "06:00" },
        { name: "Evening", start: "17:00" },
      ],
    });
    const morning = await (await h.complete(h.standard, "morning")).json();
    expect(morning.nextDue).toMatchObject({ dueDate: "2026-03-01", timeSlot: "Evening" });

    const res = await (
      await h.standard.post(`${h.base}/${h.chore.id}/complete-early`, {
        idempotencyKey: "evening",
        dueDate: "2026-03-01",
        timeSlot: "Evening",
      })
    ).json();

    expect(res).toMatchObject({
      outcome: "completed",
      completion: { dueDate: "2026-03-01", timeSlot: "Evening", early: true },
      nextDue: { dueDate: "2026-03-02", timeSlot: "Morning" },
    });
  });

  test("a dueDate is required, and outsiders get 404", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household(everyNDays(1));
    expect((await h.standard.post(`${h.base}/${h.chore.id}/complete-early`, { idempotencyKey: "k" })).status).toBe(400);

    const other = await t.seed({ timeZone: "Europe/London", adminName: "Outsider" });
    const outsider = await t.signIn(other.person.id);
    expect((await h.completeEarly(outsider, "k", "2026-03-02")).status).toBe(404);
  });
});

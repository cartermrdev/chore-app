import { describe, expect, test } from "bun:test";
import { useTestApp, type TestClient } from "./harness";

const everyNDays = (n: number) => ({ kind: "fixed", rule: { type: "every_n_days", n } });

describe("Manual Completion", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });

  /** A Household (Europe/London) with an Admin, a Standard Person and one every-N-days Chore. */
  async function household(n: number) {
    const { person, household } = await t.seed({ timeZone: "Europe/London", adminName: "Alex" });
    const admin = await t.signIn(person.id);
    const sam = await t.addPerson(household.id, { displayName: "Sam", role: "standard" });
    const standard = await t.signIn(sam.id);
    const base = `/api/households/${household.id}/chores`;
    const chore = await (await admin.post(base, { name: "Dishes", schedule: everyNDays(n) })).json();
    const complete = (client: TestClient, idempotencyKey: string) =>
      client.post(`${base}/${chore.id}/complete`, { idempotencyKey });
    const detail = async (client: TestClient = admin) => (await client.get(`${base}/${chore.id}`)).json();
    return { admin, standard, adminPerson: person, sam, base, chore, complete, detail };
  }

  test("records the Person, the time and Method Manual against the due Occurrence", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household(1);
    t.clock.set("2026-03-01T18:30:00Z");

    const res = await h.complete(h.standard, "key-1");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      outcome: "completed",
      completion: {
        choreName: "Dishes",
        dueDate: "2026-03-01",
        completer: { id: h.sam.id, displayName: "Sam" },
        recorder: { id: h.sam.id, displayName: "Sam" },
        method: "manual",
        tagId: null,
        completedAt: "2026-03-01T18:30:00.000Z",
        late: false,
      },
      nextDue: { dueDate: "2026-03-02" },
    });

    const { chores } = await (await h.admin.get(h.base)).json();
    expect(chores[0]).toMatchObject({
      currentOccurrence: {
        dueDate: "2026-03-01",
        status: "completed",
        completion: { completer: { displayName: "Sam" }, method: "manual", completedAt: "2026-03-01T18:30:00.000Z" },
      },
      nextDue: { dueDate: "2026-03-02", timeSlot: null, dueTime: "2026-03-03T00:00:00.000Z" },
    });
  });

  test("two concurrent requests for the same Occurrence produce exactly one Completion", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household(1);

    const [a, b] = await Promise.all([h.complete(h.admin, "alex-key"), h.complete(h.standard, "sam-key")]);
    const bodies = [await a.json(), await b.json()];

    const won = bodies.filter((r) => r.outcome === "completed");
    const lost = bodies.filter((r) => r.outcome === "already_completed");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].completion.completer).toEqual(won[0].completion.completer);
    expect(lost[0].completion.id).toBe(won[0].completion.id);

    const detail = await h.detail();
    expect(detail.occurrences).toHaveLength(1);
    expect(detail.occurrences[0].completion.id).toBe(won[0].completion.id);
  });

  test("a second press once the Occurrence is done says who already completed it and records nothing", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household(1);
    const first = await (await h.complete(h.standard, "k1")).json();
    t.clock.set("2026-03-01T10:00:00Z");

    const second = await (await h.complete(h.admin, "k2")).json();

    expect(second).toEqual({
      outcome: "already_completed",
      completion: first.completion,
      nextDue: { dueDate: "2026-03-02", timeSlot: null, dueTime: "2026-03-03T00:00:00.000Z" },
    });
    expect(second.completion.completer.displayName).toBe("Sam");
  });

  test("repeating a request with the same idempotency key returns the original result and creates nothing", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household(1);
    const original = await (await h.complete(h.standard, "same-key")).json();

    // Concurrent and later repeats, even once a new Occurrence is due.
    const repeats = await Promise.all([h.complete(h.standard, "same-key"), h.complete(h.standard, "same-key")]);
    t.clock.set("2026-03-02T09:00:00Z");
    const later = await h.complete(h.standard, "same-key");

    for (const r of [...repeats, later]) {
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual(original);
    }
    const detail = await h.detail();
    expect(detail.occurrences.map((o: any) => [o.dueDate, o.status])).toEqual([
      ["2026-03-01", "completed"],
      ["2026-03-02", "open"],
    ]);
  });

  test("an idempotency key is scoped to the Household: reusing it in another Household records there", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const a = await household(1);
    const b = await household(1);
    const invite = await (await b.admin.post(b.base.replace("/chores", "/invites"), { displayName: "Sam" })).json();
    expect((await a.standard.post(`/api/invites/${invite.token}/join`)).status).toBe(200);
    expect((await a.complete(a.standard, "same-key")).status).toBe(200);

    const res = await a.standard.post(`${b.base}/${b.chore.id}/complete`, { idempotencyKey: "same-key" });

    expect(await res.json()).toMatchObject({
      outcome: "completed",
      completion: { choreId: b.chore.id, completer: { id: a.sam.id } },
    });
  });

  test("concurrent first requests with the same idempotency key create one Completion", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household(1);

    const results = await Promise.all([1, 2, 3].map(() => h.complete(h.standard, "dup")));
    const bodies = await Promise.all(results.map((r) => r.json()));

    for (const b of bodies) expect(b).toEqual(bodies[0]);
    expect(bodies[0].outcome).toBe("completed");
  });

  test("a Completion after the end of the due date, within the Window, is Late", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household(3); // due 2026-03-01 (by midnight), Window until 2026-03-04

    t.clock.set("2026-03-01T23:59:59Z");
    const onTime = await (await h.complete(h.standard, "a")).json();
    expect(onTime.completion.late).toBe(false);

    t.clock.set("2026-03-04T09:00:00Z"); // next Occurrence (due 03-04)
    t.clock.set("2026-03-05T00:00:01Z"); // just after its due date ended
    const late = await (await h.complete(h.standard, "b")).json();
    expect(late.completion).toMatchObject({ dueDate: "2026-03-04", late: true });
  });

  test("a Missed Occurrence can no longer be completed", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household(2);
    t.clock.set("2026-03-03T10:00:00Z"); // 03-01's Window has closed; 03-03 is due

    const res = await (await h.complete(h.standard, "k")).json();

    expect(res.completion.dueDate).toBe("2026-03-03");
    const detail = await h.detail();
    expect(detail.occurrences.map((o: any) => [o.dueDate, o.status, o.completion])).toEqual([
      ["2026-03-01", "missed", null],
      ["2026-03-03", "completed", expect.objectContaining({ completer: { id: h.sam.id, displayName: "Sam" } })],
    ]);
  });

  test("before a Chore's first due date there is nothing due", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const { person, household: hh } = await t.seed();
    const admin = await t.signIn(person.id);
    const base = `/api/households/${hh.id}/chores`;
    const chore = await (
      await admin.post(base, { name: "Later", schedule: { ...everyNDays(1), startDate: "2026-03-10" } })
    ).json();

    const res = await (await admin.post(`${base}/${chore.id}/complete`, { idempotencyKey: "x" })).json();

    expect(res).toEqual({ outcome: "nothing_due", nextDue: { dueDate: "2026-03-10", timeSlot: null, dueTime: "2026-03-11T00:00:00.000Z" } });
  });

  test("a request without an idempotency key is rejected", async () => {
    const h = await household(1);
    const res = await h.standard.post(`${h.base}/${h.chore.id}/complete`, {});
    expect(res.status).toBe(400);
  });

  test("a Person outside the Household cannot complete its Chores", async () => {
    const h = await household(1);
    const other = await t.seed();
    const outsider = await t.signIn(other.person.id);

    const res = await h.complete(outsider, "k");

    expect(res.status).toBe(404);
    expect((await h.detail()).occurrences[0].status).toBe("open");
  });
});

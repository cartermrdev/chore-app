import { describe, expect, test } from "bun:test";
import { useTestApp, type TestClient } from "./harness";

const everyNDays = (n: number) => ({ kind: "fixed", rule: { type: "every_n_days", n } });

describe("Scan", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });

  /** A Household (Europe/London) with an Admin, a Standard Person, a Chore and a Tag linked to it. */
  async function household(schedule: unknown = everyNDays(1)) {
    const { person, household } = await t.seed({ timeZone: "Europe/London", adminName: "Alex" });
    const admin = await t.signIn(person.id);
    const sam = await t.addPerson(household.id, { displayName: "Sam", role: "standard" });
    const standard = await t.signIn(sam.id);
    const base = `/api/households/${household.id}`;
    const chore = await (await admin.post(`${base}/chores`, { name: "Dishes", schedule })).json();
    const tag = await (await admin.post(`${base}/tags`, { choreId: chore.id })).json();
    const scan = (client: TestClient, idempotencyKey: string, tagId: string = tag.id) =>
      client.post(`/api/scan/${tagId}`, { idempotencyKey });
    const detail = async () => (await admin.get(`${base}/chores/${chore.id}`)).json();
    return { admin, standard, sam, adminPerson: person, base, chore, tag, scan, detail };
  }

  test("a scan completes the due Occurrence for the signed-in Person with Method NFC and records the Tag", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    t.clock.set("2026-03-01T18:30:00Z");

    const res = await h.scan(h.standard, "scan-1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: "completed",
      chore: { id: h.chore.id, name: "Dishes" },
      completion: expect.objectContaining({
        dueDate: "2026-03-01",
        completer: { id: h.sam.id, displayName: "Sam" },
        recorder: { id: h.sam.id, displayName: "Sam" },
        method: "nfc",
        tagId: h.tag.id,
        completedAt: "2026-03-01T18:30:00.000Z",
        late: false,
      }),
      nextDue: { dueDate: "2026-03-02", dueTime: "2026-03-03T00:00:00.000Z" },
    });
    const detail = await h.detail();
    expect(detail.occurrences[0]).toMatchObject({
      status: "completed",
      completion: { method: "nfc", tagId: h.tag.id, completer: { displayName: "Sam" } },
    });
  });

  test("scanning again once it's done says who completed it and when it's next due, and records nothing", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    const first = await (await h.scan(h.standard, "a")).json();
    t.clock.set("2026-03-01T10:00:00Z");

    const again = await (await h.scan(h.admin, "b")).json();

    expect(again).toEqual({
      outcome: "already_completed",
      chore: { id: h.chore.id, name: "Dishes" },
      completion: first.completion,
      nextDue: { dueDate: "2026-03-02", dueTime: "2026-03-03T00:00:00.000Z" },
    });
    expect((await h.detail()).occurrences).toHaveLength(1);
  });

  test("before the Chore is first due, a scan reports nothing due and when it next is", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household({ ...everyNDays(1), startDate: "2026-03-05" });

    const res = await (await h.scan(h.standard, "k")).json();

    expect(res).toEqual({
      outcome: "nothing_due",
      chore: { id: h.chore.id, name: "Dishes" },
      nextDue: { dueDate: "2026-03-05", dueTime: "2026-03-06T00:00:00.000Z" },
      earlyCompletionOffered: false,
    });
  });

  test("a Tag that points at no Chore reports tag_unlinked, offering the link only to Admins", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    await h.admin.patch(`${h.base}/tags/${h.tag.id}`, { choreId: null });

    const asStandard = await (await h.scan(h.standard, "s")).json();
    const asAdmin = await (await h.scan(h.admin, "a")).json();

    expect(asStandard).toEqual({ outcome: "tag_unlinked", householdId: expect.any(String), canLink: false });
    expect(asAdmin).toMatchObject({ outcome: "tag_unlinked", canLink: true });
    expect((await h.detail()).occurrences[0].status).toBe("open");
  });

  test("a Tag whose Chore is Archived reports tag_unlinked", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    // Setup only: there is no Archive API yet.
    await t.db`UPDATE chores SET archived_at = ${t.clock.now()} WHERE id = ${h.chore.id}`;

    const res = await (await h.scan(h.standard, "k")).json();

    expect(res).toMatchObject({ outcome: "tag_unlinked", canLink: false });
  });

  test("a Person outside the Tag's Household is told only that they are not a member", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    const other = await t.seed();
    const outsider = await t.signIn(other.person.id);

    const res = await h.scan(outsider, "k");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "not_a_member" });
    expect((await h.detail()).occurrences[0].status).toBe("open");
  });

  test("retrying a scan with the same idempotency key returns the original result and records one Completion", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();

    const results = await Promise.all([1, 2, 3].map(() => h.scan(h.standard, "retry-key")));
    const bodies = await Promise.all(results.map((r) => r.json()));
    t.clock.set("2026-03-01T09:00:10Z");
    const later = await (await h.scan(h.standard, "retry-key")).json();

    for (const b of [...bodies, later]) expect(b).toEqual(bodies[0]);
    expect(bodies[0].outcome).toBe("completed");
  });

  test("a scan key never replays a Manual completion that used the same key", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    const manual = await (await h.standard.post(`${h.base}/chores/${h.chore.id}/complete`, { idempotencyKey: "same" })).json();

    const scan = await (await h.scan(h.standard, "same")).json();

    expect(scan).toMatchObject({ outcome: "already_completed", completion: { id: manual.completion.id, method: "manual" } });
  });

  test("a GET to the scan routes never creates a Completion", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();

    const gets = [await h.standard.get(`/api/scan/${h.tag.id}`), await h.standard.get(`/nfc/${h.tag.id}`)];

    for (const r of gets) expect(r.status).toBe(404);
    expect((await h.detail()).occurrences[0]).toMatchObject({ status: "open", completion: null });
  });

  test("an unknown Tag, a missing key or a missing session is rejected without completing anything", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();

    expect((await h.scan(h.standard, "k", "AAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    expect((await h.standard.post(`/api/scan/${h.tag.id}`, {})).status).toBe(400);
    expect((await h.scan(t.anonymous(), "k")).status).toBe(401);
    expect((await h.detail()).occurrences[0].status).toBe("open");
  });
});

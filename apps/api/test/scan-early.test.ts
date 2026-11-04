import { describe, expect, test } from "bun:test";
import { useTestApp, type TestClient } from "./harness";

describe("Scan: Complete early", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });

  /** A Household (Europe/London) with an Admin, a Standard Person, an Interval Chore and a Tag linked to it. */
  async function household(schedule: unknown = { kind: "interval", periodDays: 30 }) {
    const { person, household } = await t.seed({ timeZone: "Europe/London", adminName: "Alex" });
    const admin = await t.signIn(person.id);
    const sam = await t.addPerson(household.id, { displayName: "Sam", role: "standard" });
    const standard = await t.signIn(sam.id);
    const base = `/api/households/${household.id}`;
    const chore = await (await admin.post(`${base}/chores`, { name: "Filter", schedule })).json();
    const tag = await (await admin.post(`${base}/tags`, { choreId: chore.id })).json();
    const scan = (client: TestClient, idempotencyKey: string) => client.post(`/api/scan/${tag.id}`, { idempotencyKey });
    const scanEarly = (client: TestClient, idempotencyKey: string, dueDate: string, tagId: string = tag.id) =>
      client.post(`/api/scan/${tagId}/complete-early`, { idempotencyKey, dueDate });
    const detail = async () => (await admin.get(`${base}/chores/${chore.id}`)).json();
    return { admin, standard, sam, base, chore, tag, scan, scanEarly, detail };
  }

  test("a Scan when nothing is due records nothing and offers Complete early", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    await h.scan(h.standard, "first");
    t.clock.set("2026-03-26T08:00:00Z");

    const res = await (await h.scan(h.standard, "again")).json();

    expect(res).toMatchObject({
      outcome: "already_completed",
      nextDue: { dueDate: "2026-03-31" },
      earlyCompletionOffered: true,
    });
    expect((await h.detail()).occurrences).toHaveLength(1);
  });

  test("Complete early from the scan screen records an Early Completion with Method NFC and the Tag", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    await h.scan(h.standard, "first");
    t.clock.set("2026-03-26T08:00:00Z");
    await h.scan(h.standard, "nothing-due");

    const res = await h.scanEarly(h.standard, "early", "2026-03-31");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      outcome: "completed",
      chore: { id: h.chore.id, name: "Filter" },
      completion: { dueDate: "2026-03-31", method: "nfc", tagId: h.tag.id, early: true, late: false, completer: { displayName: "Sam" } },
      nextDue: { dueDate: "2026-04-25" },
    });
    // Retrying the same request changes nothing.
    const again = await (await h.scanEarly(h.standard, "early", "2026-03-31")).json();
    expect(again.outcome).toBe("completed");
    expect((await h.detail()).occurrences).toHaveLength(2);
  });

  test("a stale Complete early (someone else already did it) reports who did", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    await h.scan(h.standard, "first");
    t.clock.set("2026-03-26T08:00:00Z");
    await h.scanEarly(h.admin, "alex", "2026-03-31");

    const res = await (await h.scanEarly(h.standard, "sam", "2026-03-31")).json();

    expect(res).toMatchObject({ outcome: "already_completed", completion: { completer: { displayName: "Alex" } } });
  });

  test("Complete early checks the Tag like a Scan: outsiders learn nothing, malformed Tag ids are 404", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household();
    const other = await t.seed({ timeZone: "Europe/London", adminName: "Outsider" });
    const outsider = await t.signIn(other.person.id);

    expect(await (await h.scanEarly(outsider, "k", "2026-03-31")).json()).toEqual({ outcome: "not_a_member" });
    expect((await h.scanEarly(h.standard, "k", "2026-03-31", "short")).status).toBe(404);
    expect((await h.standard.post(`/api/scan/${h.tag.id}/complete-early`, { idempotencyKey: "k" })).status).toBe(400);
    expect((await t.anonymous().post(`/api/scan/${h.tag.id}/complete-early`, { idempotencyKey: "k", dueDate: "2026-03-31" })).status).toBe(401);
  });

  test("a completed One-off Chore offers no Complete early", async () => {
    t.clock.set("2026-03-01T09:00:00Z");
    const h = await household({ kind: "one_off", dueDate: "2026-03-01" });
    await h.scan(h.standard, "done");

    const res = await (await h.scan(h.standard, "again")).json();

    expect(res).toMatchObject({ outcome: "already_completed", nextDue: null, earlyCompletionOffered: false });
  });
});

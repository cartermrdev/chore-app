import { describe, expect, test } from "bun:test";
import { useTestApp } from "./harness";

describe("Memberships and Roles", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });

  /** Household with Admin Alex and Standard Sam. */
  async function household() {
    const { person: alex, household } = await t.seed({ timeZone: "Europe/London", adminName: "Alex" });
    const admin = await t.signIn(alex.id);
    const sam = await t.addPerson(household.id, { displayName: "Sam", role: "standard" });
    const standard = await t.signIn(sam.id);
    const persons = `/api/households/${household.id}/persons`;
    const list = async () => (await (await admin.get(persons)).json()).persons;
    return { alex, admin, sam, standard, household, persons, list };
  }

  test("an Admin promotes a Standard Person to Admin and demotes them again", async () => {
    const h = await household();

    const promote = await h.admin.patch(`${h.persons}/${h.sam.id}`, { role: "admin" });
    expect(promote.status).toBe(200);
    expect(await promote.json()).toEqual({ id: h.sam.id, displayName: "Sam", role: "admin" });
    expect(await h.list()).toEqual([
      { id: h.alex.id, displayName: "Alex", role: "admin" },
      { id: h.sam.id, displayName: "Sam", role: "admin" },
    ]);

    const demote = await h.admin.patch(`${h.persons}/${h.sam.id}`, { role: "standard" });
    expect(demote.status).toBe(200);
    expect(await h.list()).toContainEqual({ id: h.sam.id, displayName: "Sam", role: "standard" });
  });

  test("demoting the last Admin is rejected", async () => {
    const h = await household();

    const res = await h.admin.patch(`${h.persons}/${h.alex.id}`, { role: "standard" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "last_admin" });
    expect(await h.list()).toContainEqual({ id: h.alex.id, displayName: "Alex", role: "admin" });
  });

  test("an Admin can demote themselves while another Admin remains", async () => {
    const h = await household();
    await h.admin.patch(`${h.persons}/${h.sam.id}`, { role: "admin" });

    expect((await h.admin.patch(`${h.persons}/${h.alex.id}`, { role: "standard" })).status).toBe(200);
    expect(await h.list()).toEqual([
      { id: h.alex.id, displayName: "Alex", role: "standard" },
      { id: h.sam.id, displayName: "Sam", role: "admin" },
    ]);
  });

  test("two Admins demoting each other at once leave exactly one Admin", async () => {
    const h = await household();
    await h.admin.patch(`${h.persons}/${h.sam.id}`, { role: "admin" });

    const results = await Promise.all([
      h.admin.patch(`${h.persons}/${h.sam.id}`, { role: "standard" }),
      h.standard.patch(`${h.persons}/${h.alex.id}`, { role: "standard" }),
    ]);

    // Whichever runs second is rejected: either last_admin, or forbidden (no longer an Admin).
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect([403, 409]).toContain(results.find((r) => r.status !== 200)!.status);
    const admins = (await h.list()).filter((p: any) => p.role === "admin");
    expect(admins).toHaveLength(1);
  });

  test("an invalid Role is rejected and an unknown Person is 404", async () => {
    const h = await household();
    expect((await h.admin.patch(`${h.persons}/${h.sam.id}`, { role: "owner" })).status).toBe(400);
    expect((await h.admin.patch(`${h.persons}/not-a-uuid`, { role: "admin" })).status).toBe(404);
    const outsider = (await t.seed()).person;
    expect((await h.admin.patch(`${h.persons}/${outsider.id}`, { role: "admin" })).status).toBe(404);
  });

  test("Standard Persons get 403 on every management action and nothing changes", async () => {
    const h = await household();
    const base = `/api/households/${h.household.id}`;
    const daily = { kind: "fixed", rule: { type: "every_n_days", n: 1 } };
    const chore = await (await h.admin.post(`${base}/chores`, { name: "Dishes", schedule: daily })).json();
    const tag = await (await h.admin.post(`${base}/tags`, { choreId: chore.id })).json();
    const done = await (await h.admin.post(`${base}/chores/${chore.id}/complete`, { idempotencyKey: "a1" })).json();
    const other = await (await h.admin.post(`${base}/chores`, { name: "Bins", schedule: daily })).json();
    const open = (await (await h.admin.get(`${base}/chores/${other.id}`)).json()).occurrences[0];
    const unregistered = "u".repeat(22);

    const attempts: [string, Promise<Response>][] = [
      // Household
      ["PATCH household", h.standard.patch(base, { timeZone: "Europe/Paris" })],
      // Chores
      ["POST chore", h.standard.post(`${base}/chores`, { name: "X", schedule: daily })],
      ["PATCH chore", h.standard.patch(`${base}/chores/${chore.id}`, { name: "Renamed" })],
      ["archive chore", h.standard.post(`${base}/chores/${chore.id}/archive`)],
      ["DELETE chore", h.standard.delete(`${base}/chores/${other.id}`)],
      // Tags
      ["GET tags", h.standard.get(`${base}/tags`)],
      ["POST tag", h.standard.post(`${base}/tags`, {})],
      ["PATCH tag", h.standard.patch(`${base}/tags/${tag.id}`, { choreId: null })],
      ["claim tag", h.standard.post(`${base}/tags/${unregistered}/claim`, { choreId: chore.id })],
      ["DELETE tag", h.standard.delete(`${base}/tags/${tag.id}`)],
      // Memberships
      ["POST invite", h.standard.post(`${base}/invites`, { displayName: "New" })],
      ["recovery invite", h.standard.post(`${base}/invites`, { personId: h.alex.id })],
      ["promote self", h.standard.patch(`${h.persons}/${h.sam.id}`, { role: "admin" })],
      ["demote Admin", h.standard.patch(`${h.persons}/${h.alex.id}`, { role: "standard" })],
      ["end Membership", h.standard.delete(`${h.persons}/${h.alex.id}`)],
      // Corrections
      ["Void", h.standard.post(`/api/completions/${done.completion.id}/void`)],
      ["Excuse", h.standard.post(`/api/occurrences/${open.id}/excuse`, { note: "ill" })],
      ["complete for someone else", h.standard.post(`${base}/chores/${chore.id}/complete`, { idempotencyKey: "s1", completerId: h.alex.id })],
      // Pause: see "Standard Persons get 403 on every Pause action" in pauses.test.ts.
    ];

    const statuses = Object.fromEntries(await Promise.all(attempts.map(async ([name, p]) => [name, (await p).status])));
    expect(statuses).toEqual(Object.fromEntries(attempts.map(([name]) => [name, 403])));

    expect(await h.list()).toEqual([
      { id: h.alex.id, displayName: "Alex", role: "admin" },
      { id: h.sam.id, displayName: "Sam", role: "standard" },
    ]);
    const after = await (await h.admin.get(`${base}/chores/${chore.id}`)).json();
    expect(after).toMatchObject({ name: "Dishes" });
    expect(after.occurrences[0].completion).toMatchObject({ id: done.completion.id });
    expect((await (await h.admin.get(`${base}/tags`)).json()).tags).toHaveLength(1);
  });

  describe("one Person in several Households", () => {
    const daily = { kind: "fixed", rule: { type: "every_n_days", n: 1 } };

    /** Sam (Standard in Household A) joins Household B through an Invite while signed in. */
    async function twoHouseholds() {
      const a = await household();
      const b = await t.seed({ householdName: "B", timeZone: "America/New_York", adminName: "Bea" });
      const bAdmin = await t.signIn(b.person.id);
      const invite = await (await bAdmin.post(`/api/households/${b.household.id}/invites`, { displayName: "Sammy", role: "standard" })).json();
      const join = await a.standard.post(`/api/invites/${invite.token}/join`);
      return { a, b, bAdmin, invite, join };
    }

    test("a signed-in Person joins another Household with the same login by accepting an Invite", async () => {
      const { a, b, join } = await twoHouseholds();

      expect(join.status).toBe(200);
      expect(await join.json()).toEqual({ personId: a.sam.id, householdId: b.household.id });
      const me = await (await a.standard.get("/api/me")).json();
      expect(me.person.id).toBe(a.sam.id);
      expect(me.memberships.map((m: any) => [m.household.id, m.role])).toEqual(
        expect.arrayContaining([
          [a.household.id, "standard"],
          [b.household.id, "standard"],
        ]),
      );
      expect(me.memberships).toHaveLength(2);
    });

    test("the Invite is single use, and an existing member can't join twice", async () => {
      const { a, b, bAdmin, invite } = await twoHouseholds();
      expect((await a.admin.post(`/api/invites/${invite.token}/join`)).status).toBe(404);

      const again = await (await bAdmin.post(`/api/households/${b.household.id}/invites`, { displayName: "x" })).json();
      const res = await a.standard.post(`/api/invites/${again.token}/join`);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "already_a_member" });
      // The Invite wasn't used up.
      expect((await t.anonymous().get(`/api/invites/${again.token}`)).status).toBe(200);
    });

    test("joining needs a session", async () => {
      const b = await t.seed();
      const admin = await t.signIn(b.person.id);
      const invite = await (await admin.post(`/api/households/${b.household.id}/invites`, { displayName: "x" })).json();
      expect((await t.anonymous().post(`/api/invites/${invite.token}/join`)).status).toBe(401);
    });

    test("scans complete Chores in whichever Household owns the Tag, with no Household choice", async () => {
      const { a, b, bAdmin } = await twoHouseholds();
      const aChore = await (await a.admin.post(`/api/households/${a.household.id}/chores`, { name: "A dishes", schedule: daily })).json();
      const aTag = await (await a.admin.post(`/api/households/${a.household.id}/tags`, { choreId: aChore.id })).json();
      const bChore = await (await bAdmin.post(`/api/households/${b.household.id}/chores`, { name: "B bins", schedule: daily })).json();
      const bTag = await (await bAdmin.post(`/api/households/${b.household.id}/tags`, { choreId: bChore.id })).json();

      const inA = await (await a.standard.post(`/api/scan/${aTag.id}`, { idempotencyKey: "a" })).json();
      const inB = await (await a.standard.post(`/api/scan/${bTag.id}`, { idempotencyKey: "b" })).json();

      expect(inA).toMatchObject({ outcome: "completed", chore: { id: aChore.id, name: "A dishes" } });
      expect(inB).toMatchObject({ outcome: "completed", chore: { id: bChore.id, name: "B bins" } });
      expect(inB.completion.completer.id).toBe(a.sam.id);
      const bDetail = await (await bAdmin.get(`/api/households/${b.household.id}/chores/${bChore.id}`)).json();
      expect(bDetail.occurrences[0].completion.completer.id).toBe(a.sam.id);
    });

    test("ending one Membership leaves the other Household untouched", async () => {
      const { a, b, bAdmin } = await twoHouseholds();

      expect((await bAdmin.delete(`/api/households/${b.household.id}/persons/${a.sam.id}`)).status).toBe(204);

      expect((await a.standard.get(`/api/households/${b.household.id}/chores`)).status).toBe(404);
      expect((await a.standard.get(`/api/households/${a.household.id}/chores`)).status).toBe(200);
    });
  });

  describe("ending a Membership", () => {
    test("an Admin ends a Membership; the Person drops off the list", async () => {
      const h = await household();

      const res = await h.admin.delete(`${h.persons}/${h.sam.id}`);

      expect(res.status).toBe(204);
      expect(await h.list()).toEqual([{ id: h.alex.id, displayName: "Alex", role: "admin" }]);
      expect((await h.admin.delete(`${h.persons}/${h.sam.id}`)).status).toBe(404);
    });

    test("ending the last Admin's Membership is rejected", async () => {
      const h = await household();

      const res = await h.admin.delete(`${h.persons}/${h.alex.id}`);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "last_admin" });
      expect(await h.list()).toContainEqual({ id: h.alex.id, displayName: "Alex", role: "admin" });
    });

    test("an Admin can leave while another Admin remains", async () => {
      const h = await household();
      await h.admin.patch(`${h.persons}/${h.sam.id}`, { role: "admin" });

      expect((await h.admin.delete(`${h.persons}/${h.alex.id}`)).status).toBe(204);
      expect((await h.standard.get(h.persons).then((r) => r.json())).persons).toEqual([
        { id: h.sam.id, displayName: "Sam", role: "admin" },
      ]);
    });

    test("the ended Membership loses access at once, and past Completions still show the Person's name", async () => {
      const h = await household();
      const base = `/api/households/${h.household.id}`;
      const chore = await (await h.admin.post(`${base}/chores`, { name: "Dishes", schedule: { kind: "fixed", rule: { type: "every_n_days", n: 1 } } })).json();
      const tag = await (await h.admin.post(`${base}/tags`, { choreId: chore.id })).json();
      const done = await (await h.standard.post(`/api/scan/${tag.id}`, { idempotencyKey: "s1" })).json();
      expect(done.outcome).toBe("completed");

      expect((await h.admin.delete(`${h.persons}/${h.sam.id}`)).status).toBe(204);

      // Same session, no access any more.
      expect((await h.standard.get(`${base}/chores`)).status).toBe(404);
      expect((await h.standard.get(`${base}/chores/${chore.id}`)).status).toBe(404);
      expect((await h.standard.get(h.persons)).status).toBe(404);
      expect((await (await h.standard.get("/api/me")).json()).memberships).toEqual([]);
      t.clock.advance({ days: 1 });
      expect((await (await h.standard.post(`/api/scan/${tag.id}`, { idempotencyKey: "s2" })).json()).outcome).toBe("not_a_member");

      // History keeps the name.
      const detail = await (await h.admin.get(`${base}/chores/${chore.id}`)).json();
      const completed = detail.occurrences.find((o: any) => o.completion);
      expect(completed.completion.completer).toEqual({ id: h.sam.id, displayName: "Sam" });
    });
  });
});

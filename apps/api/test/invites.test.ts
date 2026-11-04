import { describe, expect, test } from "bun:test";
import { FakeDevice } from "./fake-webauthn";
import { useTestApp } from "./harness";

describe("Invites", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });

  test("an Admin invites a new Person by display name; opening the Invite enrols a passkey, creates the Membership and signs them in", async () => {
    const { person, household } = await t.seed({ householdName: "The Smiths", adminName: "Alex" });
    const alex = await t.signIn(person.id);

    const created = await alex.post(`/api/households/${household.id}/invites`, { displayName: "Sam" });
    expect(created.status).toBe(201);
    const invite = await created.json();
    expect(invite).toMatchObject({ kind: "new", displayName: "Sam", role: "standard" });
    expect(invite.path).toMatch(/^\/invite\/[A-Za-z0-9_-]{40,}$/);

    const sam = t.anonymous();
    const opened = await sam.get(`/api/invites/${invite.token}`);
    expect(await opened.json()).toEqual({ kind: "new", displayName: "Sam", household: { name: "The Smiths" } });

    const res = await t.acceptInvite(sam, invite.token, new FakeDevice());
    expect(res.status).toBe(200);

    const me = await (await sam.get("/api/me")).json();
    expect(me.person.displayName).toBe("Sam");
    expect(me.memberships).toEqual([
      { role: "standard", household: expect.objectContaining({ id: household.id, name: "The Smiths" }) },
    ]);
  });

  async function adminWithHousehold() {
    const { person, household } = await t.seed({ adminName: "Alex" });
    const alex = await t.signIn(person.id);
    const invite = async (body: unknown) => alex.post(`/api/households/${household.id}/invites`, body);
    return { household, alex, invite };
  }

  test("an Invite can be used only once", async () => {
    const { invite } = await adminWithHousehold();
    const { token } = await (await invite({ displayName: "Sam" })).json();
    expect((await t.acceptInvite(t.anonymous(), token)).status).toBe(200);

    const second = t.anonymous();
    expect((await second.get(`/api/invites/${token}`)).status).toBe(404);
    expect((await t.acceptInvite(second, token)).status).toBe(404);
    expect((await second.get("/api/me")).status).toBe(401);
  });

  test("an Invite opened twice at once is accepted only once", async () => {
    const { invite } = await adminWithHousehold();
    const { token } = await (await invite({ displayName: "Sam" })).json();
    const [a, b] = [t.anonymous(), t.anonymous()];
    const [ca, cb] = await Promise.all([a, b].map(async (c) => (await c.post(`/api/invites/${token}/options`)).json()));
    const [da, db] = [new FakeDevice(), new FakeDevice()];

    const results = await Promise.all([
      a.post(`/api/invites/${token}/accept`, { challengeId: ca.challengeId, response: da.create(ca.options) }),
      b.post(`/api/invites/${token}/accept`, { challengeId: cb.challengeId, response: db.create(cb.options) }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
  });

  test("an Invite expires after 7 days", async () => {
    const { invite } = await adminWithHousehold();
    const { token, expiresAt } = await (await invite({ displayName: "Sam" })).json();
    expect(expiresAt).toBe("2026-03-08T09:00:00.000Z");

    t.clock.advance({ days: 7, seconds: 1 });

    expect((await t.anonymous().get(`/api/invites/${token}`)).status).toBe(404);
    expect((await t.acceptInvite(t.anonymous(), token)).status).toBe(404);
    t.clock.set("2026-03-01T09:00:00Z");
  });

  test("a bad passkey response doesn't use up the Invite", async () => {
    const { invite } = await adminWithHousehold();
    const { token } = await (await invite({ displayName: "Sam" })).json();
    const phone = t.anonymous();
    const { challengeId } = await (await phone.post(`/api/invites/${token}/options`)).json();

    const bad = await phone.post(`/api/invites/${token}/accept`, {
      challengeId,
      response: new FakeDevice().create({ challenge: "not the one we were given" }),
    });

    expect(bad.status).toBe(400);
    expect((await t.acceptInvite(phone, token)).status).toBe(200);
  });

  test("an Admin can invite another Admin", async () => {
    const { invite, household } = await adminWithHousehold();
    const { token } = await (await invite({ displayName: "Jo", role: "admin" })).json();
    const jo = t.anonymous();

    await t.acceptInvite(jo, token);

    expect((await (await jo.get("/api/me")).json()).memberships).toEqual([
      { role: "admin", household: expect.objectContaining({ id: household.id }) },
    ]);
  });

  test("an Invite needs a display name and a valid Role", async () => {
    const { invite } = await adminWithHousehold();
    expect((await invite({})).status).toBe(400);
    expect((await invite({ displayName: "   " })).status).toBe(400);
    expect((await invite({ displayName: "Sam", role: "owner" })).status).toBe(400);
  });

  test("a Standard Person can't create Invites, and outsiders see nothing", async () => {
    const { household } = await adminWithHousehold();
    const sam = await t.addPerson(household.id, { displayName: "Sam", role: "standard" });
    const standard = await t.signIn(sam.id);
    const other = await t.seed();
    const outsider = await t.signIn(other.person.id);

    expect((await standard.post(`/api/households/${household.id}/invites`, { displayName: "X" })).status).toBe(403);
    expect((await outsider.post(`/api/households/${household.id}/invites`, { displayName: "X" })).status).toBe(404);
    expect((await t.anonymous().post(`/api/households/${household.id}/invites`, { displayName: "X" })).status).toBe(401);
  });

  describe("recovery", () => {
    test("an Admin issues a recovery Invite to an existing Person, who enrols a new passkey and is signed in as themselves", async () => {
      const { invite, household } = await adminWithHousehold();
      const first = await (await invite({ displayName: "Sam" })).json();
      const lostPhone = new FakeDevice();
      const oldPhone = t.anonymous();
      const accepted = await (await t.acceptInvite(oldPhone, first.token, lostPhone)).json();

      const recovery = await invite({ personId: accepted.personId });
      expect(recovery.status).toBe(201);
      const r = await recovery.json();
      expect(r).toMatchObject({ kind: "recovery", displayName: "Sam", personId: accepted.personId });
      expect(await (await t.anonymous().get(`/api/invites/${r.token}`)).json()).toEqual({
        kind: "recovery",
        displayName: "Sam",
        household: { name: expect.any(String) },
      });

      const newPhone = new FakeDevice();
      const phone = t.anonymous();
      expect((await t.acceptInvite(phone, r.token, newPhone)).status).toBe(200);

      const me = await (await phone.get("/api/me")).json();
      expect(me.person).toMatchObject({ id: accepted.personId, displayName: "Sam" });
      expect(me.memberships).toEqual([{ role: "standard", household: expect.objectContaining({ id: household.id }) }]);
      // The new passkey signs in as the same Person later.
      const later = t.anonymous();
      expect((await t.signInWithPasskey(later, newPhone)).status).toBe(200);
      expect((await (await later.get("/api/me")).json()).person.id).toBe(accepted.personId);
    });

    test("a recovery Invite is only for a Person currently in the Admin's Household", async () => {
      const { invite } = await adminWithHousehold();
      const other = await t.seed();

      expect((await invite({ personId: other.person.id })).status).toBe(404);
      expect((await invite({ personId: "not-a-uuid" })).status).toBe(404);
    });
  });
});

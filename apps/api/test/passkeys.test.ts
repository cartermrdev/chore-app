import { describe, expect, test } from "bun:test";
import { FakeDevice } from "./fake-webauthn";
import { useTestApp, type TestClient } from "./harness";

describe("passkeys", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });

  /** A Household with an Admin and a Standard Person "Sam" enrolled on `device` through an Invite. */
  async function samEnrolled(device = new FakeDevice()) {
    const { person, household } = await t.seed({ adminName: "Alex" });
    const alex = await t.signIn(person.id);
    const invite = await (await alex.post(`/api/households/${household.id}/invites`, { displayName: "Sam" })).json();
    expect((await t.acceptInvite(t.anonymous(), invite.token, device)).status).toBe(200);
    return { household, alex, device };
  }

  const displayName = async (client: TestClient) => (await (await client.get("/api/me")).json()).person?.displayName;

  test("a Person signs in with the passkey they enrolled", async () => {
    const { device } = await samEnrolled();
    const phone = t.anonymous();

    const res = await t.signInWithPasskey(phone, device);

    expect(res.status).toBe(200);
    expect(await displayName(phone)).toBe("Sam");
  });

  test("the session is an HttpOnly cookie lasting 90 days", async () => {
    const { device } = await samEnrolled();

    const res = await t.signInWithPasskey(t.anonymous(), device);

    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Max-Age=7776000/);
  });

  test("a passkey that was never enrolled is refused", async () => {
    await samEnrolled();
    const stranger = new FakeDevice();
    stranger.create({ challenge: "registered nowhere" });
    const phone = t.anonymous();

    const res = await t.signInWithPasskey(phone, stranger);

    expect(res.status).toBe(401);
    expect((await phone.get("/api/me")).status).toBe(401);
  });

  test("an assertion can't be replayed", async () => {
    const { device } = await samEnrolled();
    const phone = t.anonymous();
    const { challengeId, options } = await (await phone.post("/api/auth/passkey/options")).json();
    const assertion = device.get(options);
    expect((await phone.post("/api/auth/passkey/verify", { challengeId, response: assertion })).status).toBe(200);

    const replay = await t.anonymous().post("/api/auth/passkey/verify", { challengeId, response: assertion });

    expect(replay.status).toBe(401);
  });

  test("an unanswered challenge expires", async () => {
    const { device } = await samEnrolled();
    const phone = t.anonymous();
    const { challengeId, options } = await (await phone.post("/api/auth/passkey/options")).json();

    t.clock.advance({ minutes: 6 });
    const res = await phone.post("/api/auth/passkey/verify", { challengeId, response: device.get(options) });

    expect(res.status).toBe(401);
  });

  test("a signed-in Person registers another passkey and can sign in with it", async () => {
    const { device } = await samEnrolled();
    const phone = t.anonymous();
    await t.signInWithPasskey(phone, device);
    const laptop = new FakeDevice();

    const { challengeId, options } = await (await phone.post("/api/auth/passkey/registration-options")).json();
    const registered = await phone.post("/api/auth/passkey/register", { challengeId, response: laptop.create(options) });
    expect(registered.status).toBe(200);

    const browser = t.anonymous();
    expect((await t.signInWithPasskey(browser, laptop)).status).toBe(200);
    expect(await displayName(browser)).toBe("Sam");
  });

  test("registering a passkey needs a session", async () => {
    expect((await t.anonymous().post("/api/auth/passkey/registration-options")).status).toBe(401);
  });

  test("signing out ends the session", async () => {
    const { device } = await samEnrolled();
    const phone = t.anonymous();
    await t.signInWithPasskey(phone, device);
    const cookieBefore = (phone as unknown as { cookie: string }).cookie;

    expect((await phone.post("/api/auth/sign-out")).status).toBe(200);

    expect((await phone.get("/api/me")).status).toBe(401);
    // The old cookie value is dead server-side too, not just cleared in the browser.
    const stolen = t.anonymous() as unknown as { cookie: string } & TestClient;
    stolen.cookie = cookieBefore;
    expect((await stolen.get("/api/me")).status).toBe(401);
  });
});

import { describe, expect, test } from "bun:test";
import { FakeDevice } from "./fake-webauthn";
import { useTestApp } from "./harness";

describe("a Scan while logged out", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });

  test("is refused until the Person signs in, then the same scan request completes the Chore for them", async () => {
    const { person, household } = await t.seed({ adminName: "Alex" });
    const alex = await t.signIn(person.id);
    const base = `/api/households/${household.id}`;
    const chore = await (
      await alex.post(`${base}/chores`, { name: "Dishes", schedule: { kind: "fixed", rule: { type: "every_n_days", n: 1 } } })
    ).json();
    const tag = await (await alex.post(`${base}/tags`, { choreId: chore.id })).json();
    const invite = await (await alex.post(`${base}/invites`, { displayName: "Sam" })).json();
    const samsPhone = new FakeDevice();
    const phone = t.anonymous();
    await t.acceptInvite(phone, invite.token, samsPhone);

    // Sam's session lapses (90 days unused), then Sam scans the Tag.
    t.clock.advance({ days: 91 });
    const refused = await phone.post(`/api/scan/${tag.id}`, { idempotencyKey: "scan-1" });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: "unauthenticated" });
    const admin = await t.signIn(person.id);
    expect((await (await admin.get(`${base}/chores/${chore.id}`)).json()).currentOccurrence.status).toBe("open");

    // One passkey prompt, then the scan page resends the same request.
    expect((await t.signInWithPasskey(phone, samsPhone)).status).toBe(200);
    const resumed = await phone.post(`/api/scan/${tag.id}`, { idempotencyKey: "scan-1" });

    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      outcome: "completed",
      completion: { completer: { displayName: "Sam" }, method: "nfc", tagId: tag.id },
    });
  });
});

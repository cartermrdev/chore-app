import { describe, expect, test } from "bun:test";
import { useTestApp } from "./harness";

describe("magic links", () => {
  const t = useTestApp({ now: "2026-03-01T09:00:00Z" });

  let seq = 0;
  /** A seeded Admin who has added an email address through the API. */
  async function personWithEmail() {
    seq += 1;
    const email = `alex${seq}@example.com`;
    const { person } = await t.seed({ adminName: "Alex" });
    const alex = await t.signIn(person.id);
    const res = await alex.patch("/api/me", { email: email.toUpperCase() });
    expect(res.status).toBe(200);
    return { person, email };
  }

  const lastMailTo = (email: string) => t.outbox.filter((m) => m.to === email).at(-1);
  const linkIn = (text: string) => new URL(text.match(/https?:\/\/\S+/)![0]);

  test("a Person adds an email address and sees it on /api/me", async () => {
    const { person } = await t.seed({ adminName: "Alex" });
    const alex = await t.signIn(person.id);

    await alex.patch("/api/me", { email: " Alex.Smith@Example.com " });

    expect((await (await alex.get("/api/me")).json()).person).toEqual({
      id: person.id,
      displayName: "Alex",
      email: "alex.smith@example.com",
    });
  });

  test("an email address belongs to one Person", async () => {
    const { email } = await personWithEmail();
    const other = await t.seed();

    const res = await (await t.signIn(other.person.id)).patch("/api/me", { email });

    expect(res.status).toBe(409);
  });

  test("an invalid email address is rejected", async () => {
    const { person } = await t.seed();
    expect((await (await t.signIn(person.id)).patch("/api/me", { email: "nope" })).status).toBe(400);
  });

  test("a Person with an email address signs in with a magic link", async () => {
    const { person, email } = await personWithEmail();
    const phone = t.anonymous();

    expect((await phone.post("/api/auth/magic-link", { email })).status).toBe(202);

    const mail = lastMailTo(email)!;
    expect(mail.subject).toMatch(/sign in/i);
    const link = linkIn(mail.text);
    expect(link.origin + link.pathname).toBe("http://localhost:5173/sign-in/magic");
    const res = await phone.post("/api/auth/magic-link/redeem", { token: link.searchParams.get("token") });
    expect(res.status).toBe(200);
    expect((await (await phone.get("/api/me")).json()).person.id).toBe(person.id);
  });

  test("the link carries where to continue to, if that is a path in the app", async () => {
    const { email } = await personWithEmail();

    await t.anonymous().post("/api/auth/magic-link", { email, next: "/nfc/abc" });
    expect(linkIn(lastMailTo(email)!.text).searchParams.get("next")).toBe("/nfc/abc");

    await t.anonymous().post("/api/auth/magic-link", { email, next: "//evil.example/x" });
    expect(linkIn(lastMailTo(email)!.text).searchParams.get("next")).toBeNull();
  });

  test("asking for a link for an unknown address looks the same but sends nothing", async () => {
    const before = t.outbox.length;

    const res = await t.anonymous().post("/api/auth/magic-link", { email: "nobody@example.com" });

    expect(res.status).toBe(202);
    expect(t.outbox.length).toBe(before);
  });

  test("a magic link works once", async () => {
    const { email } = await personWithEmail();
    await t.anonymous().post("/api/auth/magic-link", { email });
    const token = linkIn(lastMailTo(email)!.text).searchParams.get("token");
    expect((await t.anonymous().post("/api/auth/magic-link/redeem", { token })).status).toBe(200);

    const again = t.anonymous();
    expect((await again.post("/api/auth/magic-link/redeem", { token })).status).toBe(401);
    expect((await again.get("/api/me")).status).toBe(401);
  });

  test("a magic link expires after 15 minutes", async () => {
    const { email } = await personWithEmail();
    await t.anonymous().post("/api/auth/magic-link", { email });
    const token = linkIn(lastMailTo(email)!.text).searchParams.get("token");

    t.clock.advance({ minutes: 15, seconds: 1 });

    expect((await t.anonymous().post("/api/auth/magic-link/redeem", { token })).status).toBe(401);
    t.clock.set("2026-03-01T09:00:00Z");
  });
});

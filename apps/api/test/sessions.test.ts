import { describe, expect, test } from "bun:test";
import { useTestApp } from "./harness";

describe("sessions", () => {
  const t = useTestApp({ now: "2026-01-01T12:00:00Z" });

  test("a session unused for more than 90 days expires", async () => {
    const { person } = await t.seed();
    const client = await t.signIn(person.id);

    t.clock.advance({ days: 90, minutes: 1 });

    expect((await client.get("/api/me")).status).toBe(401);
  });

  test("a session extends with use", async () => {
    const { person } = await t.seed();
    const client = await t.signIn(person.id);

    t.clock.advance({ days: 60 });
    expect((await client.get("/api/me")).status).toBe(200);
    t.clock.advance({ days: 60 });

    expect((await client.get("/api/me")).status).toBe(200);
  });
});

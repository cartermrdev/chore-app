import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { systemClock } from "../src/clock";
import { loadConfig } from "../src/config";
import { useTestApp } from "./harness";

describe("test-only sign-in", () => {
  test("cannot be enabled in production", () => {
    expect(() => loadConfig({ APP_ENV: "production", ENABLE_TEST_AUTH: "1" })).toThrow();
    expect(() =>
      createApp({ db: null as never, clock: systemClock, config: { env: "production", testAuth: true } }),
    ).toThrow();
  });

  test("is off unless explicitly enabled", () => {
    expect(loadConfig({ APP_ENV: "development" }).testAuth).toBe(false);
  });

  describe("when disabled", () => {
    const t = useTestApp({ config: { testAuth: false } });

    test("the sign-in path does not exist", async () => {
      const { person } = await t.seed();
      const res = await t.anonymous().post("/api/test/sign-in", { personId: person.id });
      expect(res.status).toBe(404);
    });

    test("the test seed path does not exist", async () => {
      const res = await t
        .anonymous()
        .post("/api/test/seed", { householdName: "X", timeZone: "Europe/London", adminName: "Y" });
      expect(res.status).toBe(404);
    });
  });

  describe("when enabled", () => {
    const t = useTestApp();

    test("a Household seeded through the test seed path is visible to its Admin", async () => {
      const seeded = await t
        .anonymous()
        .post("/api/test/seed", { householdName: "Via HTTP", timeZone: "America/New_York", adminName: "Sam" });
      expect(seeded.status).toBe(200);
      const { person } = await seeded.json();

      const me = await (await (await t.signIn(person.id)).get("/api/me")).json();

      expect(me.memberships[0].household).toMatchObject({ name: "Via HTTP", timeZone: "America/New_York" });
    });

    test("signing in as an unknown Person fails", async () => {
      const res = await t
        .anonymous()
        .post("/api/test/sign-in", { personId: "00000000-0000-0000-0000-000000000000" });
      expect(res.status).toBe(404);
    });
  });
});

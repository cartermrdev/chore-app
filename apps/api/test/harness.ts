/**
 * API test harness (Seam 1). Runs requests against the Hono app in-process,
 * against a real Postgres database created just for this test file, with a
 * controllable clock.
 *
 * Isolation: every createTestApp() creates a uniquely named database in the
 * shared container (docker compose service `db`, port 54329), applies the
 * migrations, and drops it on close. Concurrent runs from many worktrees
 * never share a database.
 */
import { afterAll, beforeAll } from "bun:test";
import { createApp, type App } from "../src/app";
import { createTestClock, type TestClock } from "../src/clock";
import type { Config } from "../src/config";
import { connect, type Db } from "../src/db/client";
import { seedHousehold, type SeedInput, type SeedResult } from "../src/households/seed";
import { createTestDatabase } from "./test-database";

export type TestClient = {
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
  patch(path: string, body?: unknown): Promise<Response>;
  put(path: string, body?: unknown): Promise<Response>;
  delete(path: string, body?: unknown): Promise<Response>;
};

export type TestApp = {
  app: App;
  /** For harness setup only (e.g. seeding). Tests assert through HTTP, not the DB. */
  db: Db;
  clock: TestClock;
  seed(input?: Partial<SeedInput>): Promise<SeedResult>;
  /** Signs in through the test-only sign-in path and returns a client carrying the session. */
  signIn(personId: string): Promise<TestClient>;
  anonymous(): TestClient;
  close(): Promise<void>;
};

export type TestAppOptions = {
  /** Initial clock time (ISO string). Defaults to 2026-01-01T12:00:00Z. */
  now?: string;
  config?: Partial<Config>;
};

function makeClient(app: App): TestClient & { cookie: string | null } {
  const client = {
    cookie: null as string | null,
    async request(method: string, path: string, body?: unknown) {
      const headers: Record<string, string> = {};
      if (client.cookie) headers.cookie = client.cookie;
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await app.request(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) client.cookie = setCookie.split(";")[0]!;
      return res;
    },
    get: (p: string) => client.request("GET", p),
    post: (p: string, b?: unknown) => client.request("POST", p, b),
    patch: (p: string, b?: unknown) => client.request("PATCH", p, b),
    put: (p: string, b?: unknown) => client.request("PUT", p, b),
    delete: (p: string, b?: unknown) => client.request("DELETE", p, b),
  };
  return client;
}

export async function createTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const database = await createTestDatabase();
  const db = connect(database.url, { max: 5 });
  const clock = createTestClock(opts.now ?? "2026-01-01T12:00:00Z");
  const config: Config = { env: "test", testAuth: true, ...opts.config };
  const app = createApp({ db, clock, config });
  let seq = 0;

  return {
    app,
    db,
    clock,
    seed: (input = {}) => {
      seq += 1;
      return seedHousehold(db, clock, {
        householdName: `Household ${seq}`,
        timeZone: "Europe/London",
        adminName: `Admin ${seq}`,
        ...input,
      });
    },
    async signIn(personId) {
      const client = makeClient(app);
      const res = await client.post("/api/test/sign-in", { personId });
      if (res.status !== 200) throw new Error(`test sign-in failed: ${res.status} ${await res.text()}`);
      return client;
    },
    anonymous: () => makeClient(app),
    async close() {
      await db.close();
      await database.drop();
    },
  };
}

/**
 * Registers beforeAll/afterAll hooks that create one TestApp for the
 * enclosing describe block (or file). Access members only inside tests.
 */
export function useTestApp(opts: TestAppOptions = {}): TestApp {
  let current: TestApp | undefined;
  beforeAll(async () => {
    current = await createTestApp(opts);
  });
  afterAll(async () => {
    await current?.close();
  });
  const get = (): TestApp => {
    if (!current) throw new Error("useTestApp(): accessed outside a test");
    return current;
  };
  return {
    get app() { return get().app; },
    get db() { return get().db; },
    get clock() { return get().clock; },
    seed: (i) => get().seed(i),
    signIn: (id) => get().signIn(id),
    anonymous: () => get().anonymous(),
    close: () => get().close(),
  };
}

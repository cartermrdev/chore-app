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
import { connect } from "../src/db/client";
import { seedHousehold, type SeedInput, type SeedResult } from "../src/households/seed";
import { createTestDatabase } from "./test-database";
import { createOutbox, type Mail } from "../src/auth/mailer";
import { fakeWebAuthn, FakeDevice } from "./fake-webauthn";

export type TestClient = {
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
  patch(path: string, body?: unknown): Promise<Response>;
  put(path: string, body?: unknown): Promise<Response>;
  delete(path: string, body?: unknown): Promise<Response>;
};

export type TestApp = {
  app: App;
  clock: TestClock;
  seed(input?: Partial<SeedInput>): Promise<SeedResult>;
  /** Adds a Person with a current Membership, through the test-only endpoint that stands in for an Invite. */
  addPerson(householdId: string, opts?: { displayName?: string; role?: "admin" | "standard" }): Promise<{ id: string; displayName: string }>;
  /** Signs in through the test-only sign-in path and returns a client carrying the session. */
  signIn(personId: string): Promise<TestClient>;
  anonymous(): TestClient;
  /** Emails the app has sent (the test Mailer keeps them instead of sending). */
  outbox: Mail[];
  /** Opens an Invite on `client`'s device and enrols a passkey (stubbed ceremony). Returns the accept response. */
  acceptInvite(client: TestClient, token: string, device?: FakeDevice): Promise<Response>;
  /** Signs `client` in with the device's passkey (stubbed ceremony). Returns the verify response. */
  signInWithPasskey(client: TestClient, device: FakeDevice): Promise<Response>;
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
  const outbox = createOutbox();
  const app = createApp({ db, clock, config, webauthn: fakeWebAuthn, mailer: outbox });
  let seq = 0;

  return {
    app,
    clock,
    seed: (input = {}) => {
      seq += 1;
      // The seed command (`bun run seed`) is the only way a Household comes into existence (ADR 0002).
      return seedHousehold(db, clock, {
        householdName: `Household ${seq}`,
        timeZone: "Europe/London",
        adminName: `Admin ${seq}`,
        ...input,
      });
    },
    addPerson(householdId, opts = {}) {
      seq += 1;
      return testEndpoint(app, "/api/test/add-person", {
        householdId,
        displayName: opts.displayName ?? `Person ${seq}`,
        role: opts.role ?? "standard",
      });
    },
    async signIn(personId) {
      const client = makeClient(app);
      const res = await client.post("/api/test/sign-in", { personId });
      if (res.status !== 200) throw new Error(`test sign-in failed: ${res.status} ${await res.text()}`);
      return client;
    },
    anonymous: () => makeClient(app),
    outbox: outbox.sent,
    acceptInvite: (client, token, device = new FakeDevice()) => acceptInvite(client, token, device),
    signInWithPasskey,
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
    get clock() { return get().clock; },
    seed: (i) => get().seed(i),
    addPerson: (h, o) => get().addPerson(h, o),
    signIn: (id) => get().signIn(id),
    anonymous: () => get().anonymous(),
    get outbox() { return get().outbox; },
    acceptInvite: (c, tok, d) => get().acceptInvite(c, tok, d),
    signInWithPasskey: (c, d) => get().signInWithPasskey(c, d),
    close: () => get().close(),
  };
}

/** Calls a test-only setup endpoint (/api/test/...), failing loudly if it refuses. */
async function testEndpoint<T>(app: App, path: string, body: unknown): Promise<T> {
  const res = await makeClient(app).post(path, body);
  if (res.status !== 200) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function acceptInvite(client: TestClient, token: string, device: FakeDevice): Promise<Response> {
  const begin = await client.post(`/api/invites/${token}/options`);
  if (begin.status !== 200) return begin;
  const { challengeId, options } = await begin.json();
  return client.post(`/api/invites/${token}/accept`, { challengeId, response: device.create(options) });
}

async function signInWithPasskey(client: TestClient, device: FakeDevice): Promise<Response> {
  const begin = await client.post("/api/auth/passkey/options");
  if (begin.status !== 200) return begin;
  const { challengeId, options } = await begin.json();
  return client.post("/api/auth/passkey/verify", { challengeId, response: device.get(options) });
}

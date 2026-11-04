/**
 * Creates uniquely named, migrated databases in the shared test Postgres
 * container (docker compose service `db`, port 54329), one per test file or
 * e2e run, so concurrent runs from different worktrees never collide.
 * No bun:test import here, so scripts/e2e.ts can use it too.
 */
import { connect, type Db } from "../src/db/client";
import { migrate } from "../src/db/migrate";

export const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://chore:chore@localhost:54329/postgres";

const TEST_DB_PREFIX = "t_";
const STALE_AFTER_MS = 6 * 3_600_000;

function urlFor(dbName: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function newDbName(): string {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `${TEST_DB_PREFIX}${Date.now()}_${process.pid}_${rand[0]!.toString(36)}${rand[1]!.toString(36)}`;
}

/** Drops test databases left behind by crashed runs (older than 6 hours). */
async function sweepStaleDatabases(admin: Db): Promise<void> {
  const rows = await admin`SELECT datname FROM pg_database WHERE datname LIKE ${TEST_DB_PREFIX + "%"}`;
  const cutoff = Date.now() - STALE_AFTER_MS;
  for (const { datname } of rows as { datname: string }[]) {
    const created = Number(datname.slice(TEST_DB_PREFIX.length).split("_")[0]);
    if (Number.isFinite(created) && created < cutoff) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`).catch(() => {});
    }
  }
}

export type TestDatabase = { url: string; name: string; drop: () => Promise<void> };

export async function createTestDatabase(): Promise<TestDatabase> {
  const admin = connect(ADMIN_URL, { max: 1 });
  try {
    await admin`SELECT 1`;
  } catch (e) {
    await admin.close().catch(() => {});
    throw new Error(`Cannot reach test Postgres at ${ADMIN_URL}. Start it with \`bun run db:up\`.\n${e}`);
  }
  const name = newDbName();
  try {
    await sweepStaleDatabases(admin);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.close();
  }

  const db = connect(urlFor(name), { max: 1 });
  try {
    await migrate(db);
  } finally {
    await db.close();
  }

  return {
    url: urlFor(name),
    name,
    drop: async () => {
      const a = connect(ADMIN_URL, { max: 1 });
      try {
        await a.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await a.close();
      }
    },
  };
}

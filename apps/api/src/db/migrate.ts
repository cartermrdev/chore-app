import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./client";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

/**
 * Applies every `migrations/NNNN_name.sql` file not yet recorded in
 * `schema_migrations`, in filename order, each in its own transaction.
 * Safe to call concurrently against the same database (advisory lock).
 */
export async function migrate(db: Db): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];

  await db.unsafe(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );

  for (const name of files) {
    await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(727274)`;
      const done = await tx`SELECT 1 FROM schema_migrations WHERE name = ${name}`;
      if (done.length > 0) return;
      const sql = await Bun.file(join(MIGRATIONS_DIR, name)).text();
      await tx.unsafe(sql);
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
      applied.push(name);
    });
  }
  return applied;
}

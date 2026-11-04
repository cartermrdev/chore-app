import { SQL } from "bun";

/** A Postgres connection pool (Bun's built-in SQL client). */
export type Db = SQL;

export function connect(url: string, opts: { max?: number } = {}): Db {
  return new SQL({ url, max: opts.max ?? 10 });
}

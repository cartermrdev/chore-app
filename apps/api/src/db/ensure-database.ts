import { connect } from "./client";

/** Creates the database named in `url` if it does not exist yet. */
export async function ensureDatabase(url: string): Promise<void> {
  const u = new URL(url);
  const name = decodeURIComponent(u.pathname.slice(1));
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Refusing unusual database name "${name}"`);
  u.pathname = "/postgres";
  const admin = connect(u.toString(), { max: 1 });
  try {
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (rows.length === 0) {
      await admin.unsafe(`CREATE DATABASE "${name}"`).catch((e: Error) => {
        if (!/already exists/.test(e.message)) throw e;
      });
    }
  } finally {
    await admin.close();
  }
}

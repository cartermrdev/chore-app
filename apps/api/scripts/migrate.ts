// Usage: bun run migrate   (uses DATABASE_URL; creates the database if missing)
import { databaseUrl } from "../src/config";
import { connect } from "../src/db/client";
import { migrate } from "../src/db/migrate";
import { ensureDatabase } from "../src/db/ensure-database";

const url = databaseUrl();
await ensureDatabase(url);
const db = connect(url, { max: 1 });
const applied = await migrate(db);
await db.close();
console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");

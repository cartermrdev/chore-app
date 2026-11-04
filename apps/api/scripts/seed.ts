// Usage: bun run seed -- --household "The Smiths" --time-zone Europe/London --admin "Alex" [--email alex@example.com]
// Creates a Household, a Person and an Admin Membership. Prints the ids as JSON.
import { parseArgs } from "node:util";
import { systemClock } from "../src/clock";
import { databaseUrl } from "../src/config";
import { connect } from "../src/db/client";
import { migrate } from "../src/db/migrate";
import { seedHousehold } from "../src/households/seed";
import { ensureDatabase } from "../src/db/ensure-database";

const { values } = parseArgs({
  options: {
    household: { type: "string" },
    "time-zone": { type: "string" },
    admin: { type: "string" },
    email: { type: "string" },
  },
});

if (!values.household || !values["time-zone"] || !values.admin) {
  console.error('Usage: bun run seed -- --household "Name" --time-zone Europe/London --admin "Name" [--email x]');
  process.exit(2);
}

const url = databaseUrl();
await ensureDatabase(url);
const db = connect(url, { max: 1 });
await migrate(db);
const result = await seedHousehold(db, systemClock, {
  householdName: values.household,
  timeZone: values["time-zone"],
  adminName: values.admin,
  adminEmail: values.email,
});
await db.close();
console.log(JSON.stringify(result));

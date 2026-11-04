// Usage: bun run seed -- --household "The Smiths" --time-zone Europe/London --admin "Alex" [--email alex@example.com]
// Creates a Household, a Person and an Admin Membership. Prints the ids and an Invite
// link (signInUrl, on PUBLIC_ORIGIN) for the Admin to enrol a passkey, as JSON.
import { parseArgs } from "node:util";
import { systemClock } from "../src/clock";
import { databaseUrl, loadConfig, publicOrigin } from "../src/config";
import { createInvite } from "../src/invites/service";
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
// The first Admin has no passkey yet: give them an Invite to enrol one (7 days).
const invite = await createInvite(
  { db, clock: systemClock },
  { kind: "recovery", householdId: result.household.id, personId: result.person.id, createdBy: result.person.id },
);
await db.close();
if ("error" in invite) throw new Error(invite.error);
const signInUrl = new URL(invite.path, publicOrigin(loadConfig())).toString();
console.log(JSON.stringify({ ...result, signInUrl }));
console.error(`\nOpen this link on the Admin's device to set up a passkey (expires ${invite.expiresAt}):\n${signInUrl}`);

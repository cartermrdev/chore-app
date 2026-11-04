import { createApp } from "./app";
import { systemClock } from "./clock";
import { databaseUrl, loadConfig } from "./config";
import { connect } from "./db/client";
import { ensureDatabase } from "./db/ensure-database";
import { migrate } from "./db/migrate";
import { consoleMailer, createOutbox } from "./auth/mailer";

const config = loadConfig();
const url = databaseUrl();
await ensureDatabase(url);
const db = connect(url);
await migrate(db);

// Test mode keeps mail in an outbox (read via GET /api/test/outbox); otherwise mail is logged.
// A real mail provider would be plugged in here for production.
const app = createApp({ db, clock: systemClock, config, mailer: config.testAuth ? createOutbox() : consoleMailer });
const port = Number(process.env.PORT ?? 3000);
const server = Bun.serve({ port, fetch: app.fetch });

console.log(`api listening on http://localhost:${server.port} (env=${config.env}, testAuth=${config.testAuth})`);

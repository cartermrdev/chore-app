// Local development: bun run dev
// Starts Postgres (shared docker compose container), the backend and the
// frontend. Override ports with API_PORT / WEB_PORT and the database with
// DATABASE_URL. Sign in with passkeys: `bun run seed` prints an Invite link for the
// first Admin (test-only sign-in exists only under APP_ENV=test).
import { join } from "node:path";
import { start, stop } from "./procs";

const root = join(import.meta.dir, "..");
const apiPort = process.env.API_PORT ?? "3000";
const webPort = process.env.WEB_PORT ?? "5173";

const up = Bun.spawnSync(["docker", "compose", "up", "-d", "--wait", "db"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (up.exitCode !== 0) process.exit(up.exitCode ?? 1);

const api = start("api", ["bun", "--watch", "apps/api/src/server.ts"], {
  cwd: root,
  env: { PORT: apiPort, APP_ENV: "development", PUBLIC_ORIGIN: `http://localhost:${webPort}` },
});
const web = start("web", ["bun", "x", "vite"], {
  cwd: join(root, "apps/web"),
  env: { WEB_PORT: webPort, API_URL: `http://localhost:${apiPort}` },
});

console.log(`\nweb: http://localhost:${webPort}   api: http://localhost:${apiPort}\n`);

const shutdown = async () => {
  await Promise.all([stop(api), stop(web)]);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await Promise.race([api.exited, web.exited]);
await shutdown();

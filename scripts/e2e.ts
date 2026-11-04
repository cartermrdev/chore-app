// Browser end-to-end runner (Seam 3). Usage: bun run test:e2e [-- <playwright args>]
//
// Creates an isolated, migrated database; starts the backend (test-only
// endpoints on) and the frontend on free ports; runs Playwright against them;
// then tears everything down. Safe to run concurrently from many worktrees.
import { join } from "node:path";
import { createTestDatabase } from "../apps/api/test/test-database";
import { freePort, start, stop, waitForHttp } from "./procs";

const root = join(import.meta.dir, "..");
const database = await createTestDatabase();
const apiPort = freePort();
const webPort = freePort();
const baseUrl = `http://localhost:${webPort}`;

const api = start("api", ["bun", "apps/api/src/server.ts"], {
  cwd: root,
  quiet: true,
  env: { DATABASE_URL: database.url, PORT: String(apiPort), APP_ENV: "test", ENABLE_TEST_AUTH: "1" },
});
const web = start("web", ["bun", "x", "vite"], {
  cwd: join(root, "apps/web"),
  quiet: true,
  env: { WEB_PORT: String(webPort), API_URL: `http://localhost:${apiPort}` },
});

let code = 1;
try {
  await waitForHttp(`http://localhost:${apiPort}/api/health`);
  await waitForHttp(`${baseUrl}/api/health`); // through the vite proxy
  const pw = Bun.spawn(["bun", "x", "playwright", "test", ...process.argv.slice(2)], {
    cwd: root,
    env: { ...process.env, E2E_BASE_URL: baseUrl },
    stdout: "inherit",
    stderr: "inherit",
  });
  code = await pw.exited;
} finally {
  await stop(web);
  await stop(api);
  await database.drop().catch((e) => console.error("failed to drop e2e database", e));
}
process.exit(code);

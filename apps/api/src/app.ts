import { Hono } from "hono";
import type { Clock } from "./clock";
import { assertValidConfig, type Config } from "./config";
import type { Db } from "./db/client";
import { testRoutes } from "./testing/routes";
import { meRoutes } from "./households/routes";
import type { CurrentMembership } from "./households/membership";
import { choreRoutes } from "./chores/routes";
import { tagRoutes } from "./tags/routes";
import { scanRoutes } from "./scan/routes";
import { completionRoutes, occurrenceRoutes } from "./completions/routes";
import { personRoutes } from "./households/persons";

/** Everything the app needs from the outside world. Tests inject their own. */
export type Deps = {
  db: Db;
  clock: Clock;
  config: Config;
};

export type AppEnv = {
  Variables: {
    deps: Deps;
    /** Set by requireSession. */
    personId: string;
    /** Set by requireMembership on /households/:householdId routes. */
    membership: CurrentMembership;
  };
};

export function createApp(deps: Deps) {
  assertValidConfig(deps.config);

  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  const api = new Hono<AppEnv>();
  api.get("/health", (c) => c.json({ ok: true }));
  api.route("/me", meRoutes);
  api.route("/households/:householdId/chores", choreRoutes);
  api.route("/households/:householdId/tags", tagRoutes);
  api.route("/scan", scanRoutes);
  api.route("/households/:householdId/persons", personRoutes);
  api.route("/completions", completionRoutes);
  api.route("/occurrences", occurrenceRoutes);
  if (deps.config.testAuth) api.route("/test", testRoutes);

  app.route("/api", api);
  return app;
}

export type App = ReturnType<typeof createApp>;

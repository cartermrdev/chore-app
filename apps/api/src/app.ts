import { Hono } from "hono";
import type { Clock } from "./clock";
import { assertValidConfig, type Config } from "./config";
import type { Db } from "./db/client";
import { testRoutes } from "./testing/routes";
import { meRoutes } from "./households/routes";

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
  if (deps.config.testAuth) api.route("/test", testRoutes);

  app.route("/api", api);
  return app;
}

export type App = ReturnType<typeof createApp>;

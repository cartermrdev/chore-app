export type AppEnv = "development" | "test" | "production";

export type Config = {
  env: AppEnv;
  /** Enables POST /api/test/sign-in. Never allowed in production. */
  testAuth: boolean;
};

export class ConfigError extends Error {}

export function assertValidConfig(config: Config): Config {
  if (config.env === "production" && config.testAuth) {
    throw new ConfigError("Test-only sign-in cannot be enabled in production");
  }
  return config;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const appEnv = (env.APP_ENV ?? env.NODE_ENV ?? "development") as AppEnv;
  if (!["development", "test", "production"].includes(appEnv)) {
    throw new ConfigError(`Unknown APP_ENV "${appEnv}"`);
  }
  return assertValidConfig({
    env: appEnv,
    testAuth: env.ENABLE_TEST_AUTH === "1",
  });
}

export function databaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.DATABASE_URL ?? "postgres://chore:chore@localhost:54329/chore_app_dev";
}

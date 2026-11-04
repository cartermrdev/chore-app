export type AppEnv = "development" | "test" | "production";

export type Config = {
  env: AppEnv;
  /** Enables the test-only /api/test/* endpoints. Allowed only when env is "test". */
  testAuth: boolean;
  /**
   * The origin the app is served from (the owned domain in production), used
   * as the passkey Relying Party and in emailed links. Defaults to
   * http://localhost:5173 (the vite dev server).
   */
  publicOrigin?: string;
};

export const DEFAULT_PUBLIC_ORIGIN = "http://localhost:5173";

export function publicOrigin(config: Config): string {
  return config.publicOrigin ?? DEFAULT_PUBLIC_ORIGIN;
}

export class ConfigError extends Error {}

export function assertValidConfig(config: Config): Config {
  if (config.testAuth && config.env !== "test") {
    throw new ConfigError("Test-only sign-in can only be enabled when APP_ENV=test");
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
    publicOrigin: env.PUBLIC_ORIGIN,
  });
}

export function databaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.DATABASE_URL ?? "postgres://chore:chore@localhost:54329/chore_app_dev";
}

import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { durationMs } from "../clock";
import type { AppEnv } from "../app";

export const SESSION_COOKIE = "sid";
export const SESSION_LIFETIME = { days: 90 };

function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

/** Creates a server-side session for the Person and sets the HttpOnly cookie. */
export async function startSession(c: Context<AppEnv>, personId: string): Promise<void> {
  const { db, clock, config } = c.var.deps;
  const token = newToken();
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + durationMs(SESSION_LIFETIME));
  await db`
    INSERT INTO sessions (token_hash, person_id, created_at, expires_at)
    VALUES (${hashToken(token)}, ${personId}, ${now}, ${expiresAt})`;
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: config.env === "production",
    path: "/",
    maxAge: durationMs(SESSION_LIFETIME) / 1000,
  });
}

/**
 * Resolves the session cookie to `c.var.personId`, extending the session
 * with use. Responds 401 when there is no valid session.
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "unauthenticated" }, 401);

  const { db, clock } = c.var.deps;
  const now = clock.now();
  const newExpiry = new Date(now.getTime() + durationMs(SESSION_LIFETIME));
  const rows = await db`
    UPDATE sessions SET expires_at = ${newExpiry}
    WHERE token_hash = ${hashToken(token)} AND expires_at > ${now}
    RETURNING person_id`;
  const row = rows[0];
  if (!row) return c.json({ error: "unauthenticated" }, 401);

  c.set("personId", row.person_id);
  await next();
};

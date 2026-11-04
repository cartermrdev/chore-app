import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { durationMs } from "../clock";
import type { AppEnv } from "../app";
import { hashToken, newToken } from "./tokens";

export const SESSION_COOKIE = "sid";
export const SESSION_LIFETIME = { days: 90 };

/** Ends the current session (if any) and clears the cookie. */
export async function endSession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.var.deps.db`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
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
 * The signed-in Person from the session cookie, extending the session with
 * use; null when there is no valid session.
 */
export async function sessionPersonId(c: Context<AppEnv>): Promise<string | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;

  const { db, clock } = c.var.deps;
  const now = clock.now();
  const newExpiry = new Date(now.getTime() + durationMs(SESSION_LIFETIME));
  const rows = await db`
    UPDATE sessions SET expires_at = ${newExpiry}
    WHERE token_hash = ${hashToken(token)} AND expires_at > ${now}
    RETURNING person_id`;
  return rows[0]?.person_id ?? null;
}

/**
 * Resolves the session cookie to `c.var.personId`, extending the session
 * with use. Responds 401 when there is no valid session.
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const personId = await sessionPersonId(c);
  if (!personId) return c.json({ error: "unauthenticated" }, 401);
  c.set("personId", personId);
  await next();
};

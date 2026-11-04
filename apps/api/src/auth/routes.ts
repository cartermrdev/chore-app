import { Hono } from "hono";
import type { AppEnv } from "../app";
import { beginRegistration, beginSignIn, finishRegistration, finishSignIn } from "./passkeys";
import { endSession, requireSession, startSession } from "./sessions";
import { redeemMagicLink, requestMagicLink } from "./magic-links";

/**
 * /api/auth: signing in and out.
 *
 * POST /magic-link { email, next? }                  -> 202 always; emails a link only if a Person has that address
 * POST /magic-link/redeem { token }                  -> 200 { personId } + session cookie; 401 if used/expired/unknown
 * POST /passkey/options                              -> { challengeId, options } (WebAuthn request options)
 * POST /passkey/verify { challengeId, response }     -> 200 { personId } + session cookie; 401 if not verified
 * POST /passkey/registration-options   (session)     -> { challengeId, options } for an extra passkey
 * POST /passkey/register { challengeId, response }   -> 200 { ok }; 400 if not verified
 * POST /sign-out                                     -> 200, session deleted and cookie cleared
 */
export const authRoutes = new Hono<AppEnv>()
  .post("/passkey/options", async (c) => c.json(await beginSignIn(c.var.deps)))
  .post("/passkey/verify", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const personId = await finishSignIn(c.var.deps, { challengeId: body?.challengeId, response: body?.response });
    if (!personId) return c.json({ error: "unauthenticated" }, 401);
    await startSession(c, personId);
    return c.json({ personId });
  })
  .post("/passkey/registration-options", requireSession, async (c) => {
    const [person] = await c.var.deps.db`SELECT id, display_name FROM persons WHERE id = ${c.var.personId}`;
    return c.json(await beginRegistration(c.var.deps, { id: person.id, displayName: person.display_name }));
  })
  .post("/passkey/register", requireSession, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const ok = await finishRegistration(c.var.deps, c.var.personId, {
      challengeId: body?.challengeId,
      response: body?.response,
    });
    return ok ? c.json({ ok: true }) : c.json({ error: "passkey_invalid" }, 400);
  })
  .post("/magic-link", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    await requestMagicLink(c.var.deps, { email: body?.email, next: body?.next });
    return c.json({ ok: true }, 202);
  })
  .post("/magic-link/redeem", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const personId = await redeemMagicLink(c.var.deps, body?.token);
    if (!personId) return c.json({ error: "unauthenticated" }, 401);
    await startSession(c, personId);
    return c.json({ personId });
  })
  .post("/sign-out", async (c) => {
    await endSession(c);
    return c.json({ ok: true });
  });

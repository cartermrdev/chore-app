import { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireSession, startSession } from "../auth/sessions";
import { requireAdmin, requireMembership } from "../households/access";
import { acceptInvite, beginInvite, createInvite, describeInvite, joinWithInvite } from "./service";

/**
 * Admin: /api/households/:householdId/invites
 *
 * POST { displayName, role?: "admin"|"standard" } -> 201 CreatedInvite (kind "new", role defaults to standard)
 * POST { personId }                              -> 201 CreatedInvite (kind "recovery" for a current member)
 * 400 for a bad body, 404 for a recovery target who isn't a current member, 403 for Standard.
 */
export const householdInviteRoutes = new Hono<AppEnv>()
  .use(requireSession, requireMembership, requireAdmin)
  .post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { householdId } = c.var.membership;
    const createdBy = c.var.personId;

    if (typeof body?.personId === "string") {
      const result = await createInvite(c.var.deps, { householdId, createdBy, kind: "recovery", personId: body.personId });
      if ("error" in result) return c.json({ error: "not_found" }, 404);
      return c.json(result, 201);
    }

    const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
    if (!displayName || displayName.length > 100) return c.json({ error: "displayName is required" }, 400);
    const role = body?.role ?? "standard";
    if (role !== "admin" && role !== "standard") return c.json({ error: "role must be admin or standard" }, 400);
    const result = await createInvite(c.var.deps, { householdId, createdBy, kind: "new", displayName, role });
    return c.json(result, 201);
  });

/**
 * Public (the Invite link is the credential): /api/invites/:token
 *
 * GET                                   -> 200 { kind, displayName, household: { name } }
 * POST /options                         -> 200 { challengeId, options } (WebAuthn creation options)
 * POST /accept { challengeId, response } -> 200 { personId } and a session cookie
 * POST /join (session)                  -> 200 { personId, householdId }: the signed-in Person joins
 *   the Household with their existing login (kind "new" only). 409 already_a_member, 401 without a session.
 * An unknown, used or expired Invite is 404 everywhere; a bad passkey response is 400.
 */
export const inviteRoutes = new Hono<AppEnv>()
  .get("/:token", async (c) => {
    const invite = await describeInvite(c.var.deps, c.req.param("token"));
    return invite ? c.json(invite) : c.json({ error: "not_found" }, 404);
  })
  .post("/:token/options", async (c) => {
    const ceremony = await beginInvite(c.var.deps, c.req.param("token"));
    return ceremony ? c.json(ceremony) : c.json({ error: "not_found" }, 404);
  })
  .post("/:token/accept", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await acceptInvite(c.var.deps, c.req.param("token"), {
      challengeId: body?.challengeId,
      response: body?.response,
    });
    if (!result.ok) {
      return result.error === "invite_invalid" ? c.json({ error: "not_found" }, 404) : c.json({ error: result.error }, 400);
    }
    await startSession(c, result.personId);
    return c.json({ personId: result.personId });
  })
  .post("/:token/join", requireSession, async (c) => {
    const result = await joinWithInvite(c.var.deps, c.req.param("token"), c.var.personId);
    if (!result.ok) {
      return result.error === "invite_invalid" ? c.json({ error: "not_found" }, 404) : c.json({ error: result.error }, 409);
    }
    return c.json({ personId: result.personId, householdId: result.householdId });
  });

import { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireSession } from "../auth/sessions";
import { requireAdmin, requireMembership } from "../households/membership";
import { claimTag, createTag, deleteTag, linkTag, listTags, type LinkResult } from "./service";

/** /api/households/:householdId/tags (Admin only). */
export const tagRoutes = new Hono<AppEnv>()
  .use(requireSession, requireMembership, requireAdmin)
  .get("/", async (c) => {
    return c.json({ tags: await listTags(c.var.deps.db, c.var.membership.householdId) });
  })
  .post("/", async (c) => {
    const choreId = parseChoreId(await c.req.json().catch(() => ({})));
    if (choreId === undefined) return c.json({ error: "choreId must be a string or null" }, 400);
    const result = await createTag(c.var.deps, {
      householdId: c.var.membership.householdId,
      createdBy: c.var.personId,
      choreId,
    });
    return respond(c, result, 201);
  })
  .patch("/:tagId", async (c) => {
    const choreId = parseChoreId(await c.req.json().catch(() => ({})));
    if (choreId === undefined) return c.json({ error: "choreId must be a string or null" }, 400);
    const result = await linkTag(c.var.deps.db, {
      householdId: c.var.membership.householdId,
      tagId: c.req.param("tagId"),
      choreId,
    });
    return respond(c, result, 200);
  })
  .post("/:tagId/claim", async (c) => {
    const choreId = parseChoreId(await c.req.json().catch(() => ({})));
    if (choreId === undefined) return c.json({ error: "choreId must be a string or null" }, 400);
    const result = await claimTag(c.var.deps, {
      householdId: c.var.membership.householdId,
      tagId: c.req.param("tagId"),
      claimedBy: c.var.personId,
      choreId,
    });
    if (result.ok) return c.json(result.tag, 201);
    if (result.error === "already_registered") return c.json({ error: "already_registered" }, 409);
    return c.json({ error: result.error }, 400);
  })
  .delete("/:tagId", async (c) => {
    const result = await deleteTag(c.var.deps.db, {
      householdId: c.var.membership.householdId,
      tagId: c.req.param("tagId"),
    });
    if (result.ok) return c.body(null, 204);
    if (result.error === "has_history") return c.json({ error: "has_history" }, 409);
    return c.json({ error: "not_found" }, 404);
  });

/** null/absent means "no Chore"; undefined means invalid. */
function parseChoreId(body: any): string | null | undefined {
  const v = body?.choreId;
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : undefined;
}

function respond(c: any, result: LinkResult, status: 200 | 201) {
  if (result.ok) return c.json(result.tag, status);
  if (result.error === "tag_not_found") return c.json({ error: "not_found" }, 404);
  return c.json({ error: "chore_not_found" }, 400);
}

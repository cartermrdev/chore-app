import { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireSession } from "../auth/sessions";
import { excuseOccurrence, undoCompletion, voidCompletion, type ExcuseResult, type WithdrawResult } from "./corrections";

const STATUS = {
  not_found: 404,
  forbidden: 403,
  undo_expired: 403,
  already_voided: 409,
  not_excusable: 409,
  note_required: 400,
} as const;

function respond(c: any, result: WithdrawResult | ExcuseResult) {
  if (result.ok) return c.json({ occurrence: result.occurrence });
  return c.json({ error: result.error }, STATUS[result.error]);
}

/**
 * /api/completions. The Household is found from the Completion, so the scan
 * page can Undo without knowing it. Non-members get 404.
 *
 * POST /:completionId/undo -> 200 { occurrence: { id, status } } | 403 forbidden/undo_expired | 404 | 409 already_voided
 * POST /:completionId/void -> same, Admin only (403 forbidden otherwise)
 */
export const completionRoutes = new Hono<AppEnv>()
  .use(requireSession)
  .post("/:completionId/undo", async (c) =>
    respond(c, await undoCompletion(c.var.deps, { completionId: c.req.param("completionId"), personId: c.var.personId })),
  )
  .post("/:completionId/void", async (c) =>
    respond(c, await voidCompletion(c.var.deps, { completionId: c.req.param("completionId"), personId: c.var.personId })),
  );

/**
 * /api/occurrences.
 *
 * POST /:occurrenceId/excuse { note } -> 200 { occurrence: { id, status: "skipped" } },
 * 400 note_required, 403 for Standard, 404 for outsiders, 409 unless Open or Missed.
 */
export const occurrenceRoutes = new Hono<AppEnv>().use(requireSession).post("/:occurrenceId/excuse", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return respond(
    c,
    await excuseOccurrence(c.var.deps, {
      occurrenceId: c.req.param("occurrenceId"),
      personId: c.var.personId,
      note: body?.note,
    }),
  );
});

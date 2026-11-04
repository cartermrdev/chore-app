import { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireSession } from "../auth/sessions";
import { parseEarlyTarget } from "../completions/service";
import { resolveEarlyScan, resolveScan } from "./resolver";

/**
 * /api/scan. The Tag URL /nfc/{tagId} is a frontend route that never changes
 * data on GET (ADR 0001); its page sends this POST. Only POST is defined here.
 *
 * POST /api/scan/:tagId { idempotencyKey } -> 200 ScanOutcome,
 * 404 for an unknown Tag, 401 without a session, 400 without a key.
 */
export const scanRoutes = new Hono<AppEnv>()
  .use(requireSession)
  .post("/:tagId", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const idempotencyKey = body?.idempotencyKey;
    if (!validKey(idempotencyKey)) return c.json({ error: "idempotencyKey is required" }, 400);
    const result = await resolveScan(c.var.deps, {
      tagId: c.req.param("tagId"),
      personId: c.var.personId,
      idempotencyKey,
    });
    if (result.outcome === "tag_not_found") return c.json({ error: "not_found" }, 404);
    return c.json(result);
  })
  /**
   * POST /api/scan/:tagId/complete-early { idempotencyKey, dueDate, timeSlot? }:
   * the scan screen's "Complete early" button. Same responses as a Scan.
   */
  .post("/:tagId/complete-early", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const idempotencyKey = body?.idempotencyKey;
    if (!validKey(idempotencyKey)) return c.json({ error: "idempotencyKey is required" }, 400);
    const target = parseEarlyTarget(body);
    if (!target) return c.json({ error: "dueDate (YYYY-MM-DD) is required" }, 400);
    const result = await resolveEarlyScan(c.var.deps, {
      tagId: c.req.param("tagId"),
      personId: c.var.personId,
      idempotencyKey,
      ...target,
    });
    if (result.outcome === "tag_not_found") return c.json({ error: "not_found" }, 404);
    return c.json(result);
  });

function validKey(key: unknown): key is string {
  return typeof key === "string" && key.length >= 1 && key.length <= 200;
}

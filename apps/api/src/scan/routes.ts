import { Hono, type Context } from "hono";
import type { AppEnv } from "../app";
import { sessionPersonId } from "../auth/sessions";
import { outcomeResponse } from "../completions/outcome-status";
import { idempotencyKeyOf, parseEarlyTarget } from "../completions/service";
import { isWellFormedTagId } from "../tags/service";
import { resolveEarlyScan, resolveScan } from "./resolver";

/**
 * /api/scan. The Tag URL /nfc/{tagId} is a frontend route that never changes
 * data on GET (ADR 0001); its page sends this POST. Only POST is defined here.
 *
 * POST /api/scan/:tagId { idempotencyKey } -> 200 ScanOutcome,
 * 401 unauthenticated without a session, 404 for a malformed Tag ID (it
 * cannot be a Tag; never a resolver outcome), 400 without a key.
 */
export const scanRoutes = new Hono<AppEnv>()
  .post("/:tagId", async (c) => {
    const request = await scanRequest(c);
    if (request instanceof Response) return request;
    return outcomeResponse(c, await resolveScan(c.var.deps, request));
  })
  /**
   * POST /api/scan/:tagId/complete-early { idempotencyKey, dueDate, timeSlot? }:
   * the scan screen's "Complete early" / "Complete anyway" button. Same responses as a Scan.
   */
  .post("/:tagId/complete-early", async (c) => {
    const request = await scanRequest(c);
    if (request instanceof Response) return request;
    const { body, ...scan } = request;
    const target = parseEarlyTarget(body);
    if (!target) return c.json({ error: "dueDate (YYYY-MM-DD) is required" }, 400);
    return outcomeResponse(c, await resolveEarlyScan(c.var.deps, { ...scan, ...target }));
  });

/** The checks every scan request shares, before the resolver: a Tag-shaped ID and an idempotency key. */
async function scanRequest(c: Context<AppEnv>) {
  const tagId = c.req.param("tagId")!;
  if (!isWellFormedTagId(tagId)) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const idempotencyKey = idempotencyKeyOf(body);
  if (!idempotencyKey) return c.json({ error: "idempotencyKey is required" }, 400);
  return { tagId, personId: await sessionPersonId(c), idempotencyKey, body };
}

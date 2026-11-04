import { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireSession } from "../auth/sessions";
import { requireAdmin, requireMembership } from "../households/access";
import { localDateOf } from "../schedule/calendar";
import { createPause, endPauseEarly, listPauses } from "./service";

/**
 * /api/households/:householdId/pauses
 * GET  (any member) -> { pauses: PauseView[] }: current, upcoming and past.
 * POST (Admin) { choreId?: string|null, startDate?: LocalDate, endDate?: LocalDate|null }
 *   -> 201 PauseView. choreId null/omitted pauses the whole Household.
 *   400 invalid_dates | start_in_past | chore_not_found.
 * POST /:pauseId/end (Admin) -> 200 PauseView; 404; 409 already_over.
 */
export const pauseRoutes = new Hono<AppEnv>()
  .use(requireSession, requireMembership)
  .get("/", async (c) => {
    const { db, clock } = c.var.deps;
    const { householdId, timeZone } = c.var.membership;
    return c.json({ pauses: await listPauses(db, householdId, localDateOf(clock.now(), timeZone)) });
  })
  .post("/", requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const choreId = body?.choreId ?? null;
    if (choreId !== null && typeof choreId !== "string") return c.json({ error: "chore_not_found" }, 400);
    const result = await createPause(c.var.deps, {
      householdId: c.var.membership.householdId,
      timeZone: c.var.membership.timeZone,
      createdBy: c.var.personId,
      choreId,
      startDate: body?.startDate,
      endDate: body?.endDate,
    });
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.pause, 201);
  })
  .post("/:pauseId/end", requireAdmin, async (c) => {
    const result = await endPauseEarly(c.var.deps, {
      householdId: c.var.membership.householdId,
      timeZone: c.var.membership.timeZone,
      pauseId: c.req.param("pauseId"),
      personId: c.var.personId,
    });
    if (result.ok) return c.json(result.pause);
    if (result.error === "already_over") return c.json({ error: "already_over" }, 409);
    return c.json({ error: "not_found" }, 404);
  });

import { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireSession } from "../auth/sessions";
import { requireMembership } from "../households/access";
import { addDays, compareDates, daysBetween, isLocalDate, localDateOf } from "../schedule/calendar";
import { historyPersons, householdHistory, personHistory, type DateRange } from "./service";

/** The longest range one request may cover, in days. */
export const MAX_RANGE_DAYS = 366;

/**
 * /api/households/:householdId/history (any Person in the Household; outsiders get 404)
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD, inclusive local dates in the Household zone.
 *   Default: the 7 days ending today. 400 invalid_range if malformed, to < from, or longer than 366 days.
 * GET /                    -> HouseholdHistory: every Completion made in the range, voided ones included, newest first.
 * GET /persons            -> { persons: { id, displayName, current }[] }: everyone who ever had a Membership
 *                             here (`current` false once it ended), for choosing whose history to view.
 *                             Listing an ended Membership grants it nothing.
 * GET /persons/:personId   -> PersonHistory; 404 if the Person never had a Membership here.
 */
export const historyRoutes = new Hono<AppEnv>()
  .use(requireSession, requireMembership)
  .get("/", async (c) => {
    const range = rangeOf(c.req.query("from"), c.req.query("to"), today(c));
    if (!range) return c.json({ error: "invalid_range" }, 400);
    const { db, clock } = c.var.deps;
    return c.json(await householdHistory({ db, membership: c.var.membership, now: clock.now() }, range));
  })
  .get("/persons", async (c) => {
    return c.json({ persons: await historyPersons(c.var.deps.db, c.var.membership.householdId) });
  })
  .get("/persons/:personId", async (c) => {
    const range = rangeOf(c.req.query("from"), c.req.query("to"), today(c));
    if (!range) return c.json({ error: "invalid_range" }, 400);
    const { db, clock } = c.var.deps;
    const history = await personHistory({ db, membership: c.var.membership, now: clock.now() }, c.req.param("personId"), range);
    if (!history) return c.json({ error: "not_found" }, 404);
    return c.json(history);
  });

function today(c: { var: AppEnv["Variables"] }) {
  return localDateOf(c.var.deps.clock.now(), c.var.membership.timeZone);
}

function rangeOf(from: string | undefined, to: string | undefined, today: string): DateRange | null {
  const end = to ?? (from && isLocalDate(from) ? addDays(from, 6) : today);
  const start = from ?? (isLocalDate(end) ? addDays(end, -6) : undefined);
  if (!isLocalDate(start) || !isLocalDate(end)) return null;
  if (compareDates(end, start) < 0 || daysBetween(start, end) >= MAX_RANGE_DAYS) return null;
  return { from: start, to: end };
}

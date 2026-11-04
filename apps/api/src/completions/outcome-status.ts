/**
 * The HTTP response for every completion outcome, whether it comes from the
 * Completion service (the Complete buttons) or the Scan resolver: one table,
 * so the routes agree on what each outcome means over HTTP.
 *
 * Outcomes a screen shows (including the Scan's `not_a_member`, which names
 * nothing) are 200 with the outcome as the body; the rest are errors.
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app";
import type { ScanOutcome } from "../scan/resolver";
import type { CompleteResult } from "./service";

type Outcome = CompleteResult["outcome"] | ScanOutcome["outcome"];

const ANSWERED = { status: 200 } as const;

export const OUTCOME_STATUS = {
  completed: ANSWERED,
  already_completed: ANSWERED,
  nothing_due: ANSWERED,
  paused: ANSWERED,
  tag_unlinked: ANSWERED,
  tag_unregistered: ANSWERED,
  not_a_member: ANSWERED,
  unauthenticated: { status: 401, error: "unauthenticated" },
  // An Admin recorded for someone who is not a current Person in the Household.
  completer_not_in_household: { status: 400, error: "completer_not_in_household" },
  forbidden: { status: 403, error: "forbidden" },
  chore_not_found: { status: 404, error: "not_found" },
} as const satisfies Record<Outcome, { status: ContentfulStatusCode; error?: string }>;

export function outcomeResponse(c: Context<AppEnv>, result: CompleteResult | ScanOutcome) {
  const response: { status: ContentfulStatusCode; error?: string } = OUTCOME_STATUS[result.outcome];
  return response.error ? c.json({ error: response.error }, response.status) : c.json(result, response.status);
}

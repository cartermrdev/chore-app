/**
 * The scan page's retry policy: the first attempt plus up to 3 automatic
 * retries, all within about 10 seconds of the first attempt, then a Retry
 * button. Each attempt's timeout is cut to what is left of the budget, so a
 * slow network (requests that hang rather than fail) can't stretch it.
 */
const BUDGET_MS = 10_000;
/** Waits before retries 1, 2 and 3. A dead network tries at about 0 s, 1 s, 4 s and 9 s. */
const DELAYS_MS = [1000, 3000, 5000];
const MAX_ATTEMPT_MS = 4000;
const MIN_ATTEMPT_MS = 1000;

export type RetryBudget = {
  /** Call as each attempt starts (the first starts the budget): that attempt's timeout. */
  attemptTimeoutMs(): number;
  /** After the attempt numbered `failures` (0-based) failed: try again? Only transient errors are retried. */
  shouldRetry(failures: number, transient: boolean): boolean;
  /** The wait before the next attempt, after `failures` (0-based) failures. */
  delayMs(failures: number): number;
  /** A new budget for a manual Retry. */
  reset(): void;
};

export function retryBudget(now: () => number = Date.now): RetryBudget {
  let startedAt: number | null = null;
  const elapsed = () => (startedAt === null ? 0 : now() - startedAt);
  return {
    attemptTimeoutMs() {
      startedAt ??= now();
      return Math.min(MAX_ATTEMPT_MS, Math.max(MIN_ATTEMPT_MS, BUDGET_MS - elapsed()));
    },
    shouldRetry(failures, transient) {
      const delay = DELAYS_MS[failures];
      return transient && delay !== undefined && elapsed() + delay < BUDGET_MS;
    },
    delayMs: (failures) => DELAYS_MS[failures] ?? DELAYS_MS.at(-1)!,
    reset() {
      startedAt = null;
    },
  };
}

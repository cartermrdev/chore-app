import { describe, expect, test } from "bun:test";
import { retryBudget } from "../src/scan-retry";

/** Simulates a scan whose every attempt fails after `failAfterMs` (or at its timeout, if sooner). */
function simulate(failAfterMs: number) {
  let now = 0;
  const budget = retryBudget(() => now);
  const attempts: { at: number; timeoutMs: number }[] = [];
  for (let failures = 0; ; failures++) {
    const timeoutMs = budget.attemptTimeoutMs();
    attempts.push({ at: now, timeoutMs });
    now += Math.min(failAfterMs, timeoutMs);
    if (!budget.shouldRetry(failures, true)) break;
    now += budget.delayMs(failures);
  }
  return { attempts, retryButtonAt: now };
}

describe("scan retry budget", () => {
  test("on a dead network it retries 3 times and offers Retry after about 10 seconds", () => {
    const { attempts, retryButtonAt } = simulate(0);

    expect(attempts).toHaveLength(4);
    expect(retryButtonAt).toBeGreaterThanOrEqual(8_000);
    expect(retryButtonAt).toBeLessThanOrEqual(10_500);
  });

  test("on a network where every request hangs, attempts are cut short so Retry still comes at about 10 seconds", () => {
    const { retryButtonAt } = simulate(Infinity);

    expect(retryButtonAt).toBeGreaterThanOrEqual(8_000);
    expect(retryButtonAt).toBeLessThanOrEqual(10_500);
  });

  test("a definite answer (not transient) is never retried", () => {
    const budget = retryBudget(() => 0);
    budget.attemptTimeoutMs();
    expect(budget.shouldRetry(0, false)).toBe(false);
  });

  test("pressing Retry starts a fresh budget", () => {
    let now = 0;
    const budget = retryBudget(() => now);
    budget.attemptTimeoutMs();
    now = 20_000;
    expect(budget.shouldRetry(0, true)).toBe(false);

    budget.reset();
    budget.attemptTimeoutMs();
    expect(budget.shouldRetry(0, true)).toBe(true);
  });
});

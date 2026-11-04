/**
 * The only source of "now" in the backend. Never call `new Date()` or
 * `Date.now()` for domain time; take a Clock from the app's dependencies so
 * tests can control time.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export type Duration = {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  ms?: number;
};

export function durationMs(d: Duration): number {
  return (
    (d.days ?? 0) * 86_400_000 +
    (d.hours ?? 0) * 3_600_000 +
    (d.minutes ?? 0) * 60_000 +
    (d.seconds ?? 0) * 1_000 +
    (d.ms ?? 0)
  );
}

export interface TestClock extends Clock {
  set(instant: string | Date): void;
  advance(by: Duration): void;
}

export function createTestClock(start: string | Date): TestClock {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set: (instant) => {
      current = new Date(instant);
    },
    advance: (by) => {
      current = new Date(current.getTime() + durationMs(by));
    },
  };
}

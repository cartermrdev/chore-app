/**
 * Pauses: periods during which a Chore (or every Chore in a Household) does
 * not fall due. Kept as history, never as an on/off flag.
 *
 * Effects live elsewhere and are derived from these rows on every
 * materialisation (`applyPauses` in occurrences/materialise.ts, and the
 * Schedule engine's Pause handling): Fixed Occurrences due inside a Pause are
 * Skipped (with `skipped_by_pause_id`); an Interval due date inside one moves
 * to the Pause's end and stays Open.
 *
 * Dates are LocalDates in the Household time zone; a Pause covers startDate
 * through endDate inclusive (null: indefinite). Ending a Pause early sets its
 * endDate to the day before it was ended (so today falls due normally again),
 * keeping the original as plannedEndDate.
 */
import type { Clock } from "../clock";
import type { Db } from "../db/client";
import { addDays, compareDates, isLocalDate, localDateOf, type LocalDate } from "../schedule/calendar";
import { pausedThrough, type Pause } from "../schedule/engine";

export type PersonRef = { id: string; displayName: string };

export type PauseView = {
  id: string;
  /** The paused Chore; null for a Household Pause. */
  chore: { id: string; name: string } | null;
  startDate: LocalDate;
  /** Last paused date (inclusive); null = indefinite. After an early end, the day before it was ended. */
  endDate: LocalDate | null;
  /** The end date as first set, when the Pause was ended early; otherwise equal to endDate. */
  plannedEndDate: LocalDate | null;
  createdAt: Date;
  createdBy: PersonRef;
  endedEarlyAt: Date | null;
  endedEarlyBy: PersonRef | null;
  /** Relative to today in the Household time zone. */
  state: "upcoming" | "current" | "past";
};

/** A stored Pause as the engine sees it, plus the Chore it applies to (null: every Chore). */
export type PauseRow = Pause & { choreId: string | null };

/** Every Pause in the Household (Chore and Household Pauses), for the engine. */
export async function loadPauses(db: Db, householdId: string): Promise<PauseRow[]> {
  const rows = await db`
    SELECT chore_id, start_date::text AS start_date, end_date::text AS end_date
    FROM pauses WHERE household_id = ${householdId}`;
  return rows.map((r: any) => ({ choreId: r.chore_id, startDate: r.start_date, endDate: r.end_date }));
}

/** The Pauses that apply to one Chore: its own and the Household's. */
export function pausesFor(rows: PauseRow[], choreId: string): Pause[] {
  return rows
    .filter((r) => r.choreId === null || r.choreId === choreId)
    .map(({ startDate, endDate }) => ({ startDate, endDate }));
}

/** The Pauses that apply to one Chore, loaded. */
export async function loadChorePauses(db: Db, householdId: string, choreId: string): Promise<Pause[]> {
  return pausesFor(await loadPauses(db, householdId), choreId);
}

/**
 * Whether the Chore is paused today: undefined if not, otherwise the last
 * paused date of the current run of Pauses (null: indefinitely).
 */
export async function pausedUntil(
  db: Db,
  input: { householdId: string; choreId: string; timeZone: string; now: Date },
): Promise<LocalDate | null | undefined> {
  const pauses = await loadChorePauses(db, input.householdId, input.choreId);
  return pausedThrough(pauses, localDateOf(input.now, input.timeZone));
}

export type CreatePauseResult =
  | { ok: true; pause: PauseView }
  | { ok: false; error: "invalid_dates" | "start_in_past" | "chore_not_found" };

/**
 * Creates a Chore Pause (choreId) or a Household Pause (choreId null),
 * starting today (startDate omitted) or in advance; never in the past.
 */
export async function createPause(
  deps: { db: Db; clock: Clock },
  input: {
    householdId: string;
    timeZone: string;
    createdBy: string;
    choreId: string | null;
    startDate?: unknown;
    endDate?: unknown;
  },
): Promise<CreatePauseResult> {
  const { db, clock } = deps;
  const now = clock.now();
  const today = localDateOf(now, input.timeZone);
  const startDate = input.startDate ?? today;
  const endDate = input.endDate ?? null;
  if (!isLocalDate(startDate) || (endDate !== null && !isLocalDate(endDate))) return { ok: false, error: "invalid_dates" };
  if (endDate !== null && compareDates(endDate, startDate) < 0) return { ok: false, error: "invalid_dates" };
  if (compareDates(startDate, today) < 0) return { ok: false, error: "start_in_past" };

  if (input.choreId !== null) {
    const [chore] = await db`
      SELECT id FROM chores
      WHERE id = ${input.choreId}::uuid AND household_id = ${input.householdId} AND archived_at IS NULL`.catch(() => []);
    if (!chore) return { ok: false, error: "chore_not_found" };
  }
  const [row] = await db`
    INSERT INTO pauses (household_id, chore_id, start_date, end_date, planned_end_date, created_at, created_by)
    VALUES (${input.householdId}, ${input.choreId}, ${startDate}::date, ${endDate}::date, ${endDate}::date, ${now}, ${input.createdBy})
    RETURNING id`;
  return { ok: true, pause: (await loadPauseViews(db, input.householdId, today, row.id))[0]! };
}

export type EndPauseResult = { ok: true; pause: PauseView } | { ok: false; error: "not_found" | "already_over" };

/**
 * Ends a Pause early: from today, Occurrences fall due normally again (an
 * advance Pause ended before it starts is left covering nothing). A Pause
 * that is already over can't be ended.
 */
export async function endPauseEarly(
  deps: { db: Db; clock: Clock },
  input: { householdId: string; timeZone: string; pauseId: string; personId: string },
): Promise<EndPauseResult> {
  const { db, clock } = deps;
  const now = clock.now();
  const today = localDateOf(now, input.timeZone);
  const yesterday = addDays(today, -1);
  const [row] = await db`
    UPDATE pauses SET
      end_date = GREATEST(${yesterday}::date, start_date - 1),
      ended_early_at = ${now},
      ended_early_by = ${input.personId}
    WHERE id = ${input.pauseId}::uuid AND household_id = ${input.householdId}
      AND (end_date IS NULL OR end_date >= ${today}::date)
    RETURNING id`.catch(() => []);
  if (!row) {
    const [exists] = await db`
      SELECT 1 FROM pauses WHERE id = ${input.pauseId}::uuid AND household_id = ${input.householdId}`.catch(() => []);
    return { ok: false, error: exists ? "already_over" : "not_found" };
  }
  return { ok: true, pause: (await loadPauseViews(db, input.householdId, today, row.id))[0]! };
}

/** Every Pause in the Household (current, upcoming and past), newest start first. */
export function listPauses(db: Db, householdId: string, today: LocalDate): Promise<PauseView[]> {
  return loadPauseViews(db, householdId, today, null);
}

async function loadPauseViews(db: Db, householdId: string, today: LocalDate, pauseId: string | null): Promise<PauseView[]> {
  const rows = await db`
    SELECT p.id, p.chore_id, c.name AS chore_name, p.start_date::text AS start_date, p.end_date::text AS end_date,
           p.planned_end_date::text AS planned_end_date, p.created_at, p.ended_early_at,
           cb.id AS created_by_id, cb.display_name AS created_by_name,
           eb.id AS ended_by_id, eb.display_name AS ended_by_name
    FROM pauses p
    LEFT JOIN chores c ON c.id = p.chore_id
    JOIN persons cb ON cb.id = p.created_by
    LEFT JOIN persons eb ON eb.id = p.ended_early_by
    WHERE p.household_id = ${householdId} AND (${pauseId}::uuid IS NULL OR p.id = ${pauseId}::uuid)
    ORDER BY p.start_date DESC, p.created_at DESC`;
  return rows.map((r: any) => ({
    id: r.id,
    chore: r.chore_id ? { id: r.chore_id, name: r.chore_name } : null,
    startDate: r.start_date,
    endDate: r.end_date,
    plannedEndDate: r.planned_end_date,
    createdAt: r.created_at,
    createdBy: { id: r.created_by_id, displayName: r.created_by_name },
    endedEarlyAt: r.ended_early_at,
    endedEarlyBy: r.ended_by_id ? { id: r.ended_by_id, displayName: r.ended_by_name } : null,
    state:
      // An advance Pause ended before it started covers nothing (end = start - 1): past too.
      r.end_date !== null && (compareDates(r.end_date, today) < 0 || compareDates(r.end_date, r.start_date) < 0)
        ? "past"
        : compareDates(r.start_date, today) > 0
          ? "upcoming"
          : "current",
  }));
}

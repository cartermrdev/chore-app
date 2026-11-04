/**
 * Read model for Chores: each Chore with its current Occurrence and when it
 * is next due. Materialises first, so reads always see up-to-date Occurrences.
 */
import type { Db } from "../db/client";
import type { CurrentMembership } from "../households/membership";
import { deriveNextDue, materialise, type NextDue } from "../occurrences/materialise";
import type { Schedule } from "../schedule/engine";

export type OccurrenceStatus = "open" | "completed" | "missed" | "skipped";

export type CompletionView = {
  id: string;
  completer: { id: string; displayName: string };
  recorder: { id: string; displayName: string };
  method: "manual" | "nfc";
  tagId: string | null;
  completedAt: Date;
  late: boolean;
};

export type OccurrenceView = {
  id: string;
  dueDate: string;
  timeSlot: string | null;
  windowStart: Date;
  dueTime: Date;
  windowEnd: Date | null;
  status: OccurrenceStatus;
  /** The active (non-voided) Completion, if any. */
  completion: CompletionView | null;
};

export type ChoreView = {
  id: string;
  name: string;
  schedule: Schedule;
  /** The earliest Open Occurrence whose Window has opened, else the latest opened one. */
  currentOccurrence: OccurrenceView | null;
  /** The earliest Open Occurrence, else the next one the Schedule will create. */
  nextDue: NextDue | null;
};

/** `archivedAt` is null for an active Chore; an Archived Chore keeps its history readable here. */
export type ChoreDetailView = ChoreView & { archivedAt: Date | null; occurrences: OccurrenceView[] };

type Scope = { db: Db; membership: CurrentMembership; now: Date };

/** Every non-archived Chore in the Household. */
export async function listChores({ db, membership, now }: Scope): Promise<ChoreView[]> {
  await materialise(db, { householdId: membership.householdId, timeZone: membership.timeZone, now });
  const chores = await db`
    SELECT id, name, schedule FROM chores
    WHERE household_id = ${membership.householdId} AND archived_at IS NULL
    ORDER BY name, created_at`;
  const occurrences = await loadOccurrences(db, membership.householdId, null);
  return chores.map((c: any) =>
    toChoreView(c, occurrences.filter((o) => o.choreId === c.id), membership.timeZone, now),
  );
}

/** One Chore in the Household with all its Occurrences, or null. */
export async function getChore({ db, membership, now }: Scope, choreId: string): Promise<ChoreDetailView | null> {
  const [chore] = await db`
    SELECT id, name, schedule, archived_at FROM chores
    WHERE household_id = ${membership.householdId} AND id = ${choreId}::uuid`.catch(() => []);
  if (!chore) return null;
  await materialise(db, { householdId: membership.householdId, timeZone: membership.timeZone, now, choreId });
  const occurrences = await loadOccurrences(db, membership.householdId, choreId);
  return {
    ...toChoreView(chore, occurrences, membership.timeZone, now),
    archivedAt: chore.archived_at,
    occurrences: occurrences.map(({ choreId: _, ...o }) => o),
  };
}

function toChoreView(chore: any, occurrences: (OccurrenceView & { choreId: string })[], timeZone: string, now: Date): ChoreView {
  const opened = occurrences.filter((o) => o.windowStart <= now).map(({ choreId: _, ...o }) => o);
  const currentOccurrence = opened.find((o) => o.status === "open") ?? opened.at(-1) ?? null;

  const nextDue = deriveNextDue(
    chore.schedule,
    timeZone,
    occurrences.find((o) => o.status === "open") ?? null,
    occurrences.at(-1) ?? null,
  );
  return { id: chore.id, name: chore.name, schedule: chore.schedule, currentOccurrence, nextDue };
}

async function loadOccurrences(db: Db, householdId: string, choreId: string | null) {
  const rows = await db`
    SELECT o.id, o.chore_id, o.due_date::text AS due_date, o.time_slot, o.window_start, o.due_time,
           o.window_end, o.status,
           c.id AS completion_id, c.method, c.tag_id, c.completed_at, c.late,
           cp.id AS completer_id, cp.display_name AS completer_name,
           rp.id AS recorder_id, rp.display_name AS recorder_name
    FROM occurrences o
    LEFT JOIN completions c ON c.occurrence_id = o.id AND c.voided_at IS NULL
    LEFT JOIN persons cp ON cp.id = c.completer_id
    LEFT JOIN persons rp ON rp.id = c.recorder_id
    WHERE o.household_id = ${householdId} AND (${choreId}::uuid IS NULL OR o.chore_id = ${choreId}::uuid)
    ORDER BY o.window_start`;
  return rows.map((r: any) => ({
    choreId: r.chore_id as string,
    id: r.id,
    dueDate: r.due_date,
    timeSlot: r.time_slot,
    windowStart: r.window_start,
    dueTime: r.due_time,
    windowEnd: r.window_end,
    status: r.status,
    completion: r.completion_id
      ? {
          id: r.completion_id,
          completer: { id: r.completer_id, displayName: r.completer_name },
          recorder: { id: r.recorder_id, displayName: r.recorder_name },
          method: r.method,
          tagId: r.tag_id,
          completedAt: r.completed_at,
          late: r.late,
        }
      : null,
  })) as (OccurrenceView & { choreId: string })[];
}

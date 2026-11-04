/**
 * Read model for Chores: each Chore with its current Occurrence and when it
 * is next due. Materialises first, so reads always see up-to-date Occurrences.
 */
import type { Db } from "../db/client";
import type { CurrentMembership } from "../households/membership";
import { deriveNextDue, materialise, type NextDue } from "../occurrences/materialise";
import { pausedThrough, type Pause, type Schedule } from "../schedule/engine";
import { localDateOf, type LocalDate } from "../schedule/calendar";
import { loadPauses, pausesFor } from "../pauses/service";

export type OccurrenceStatus = "open" | "completed" | "missed" | "skipped";

export type PersonRef = { id: string; displayName: string };

export type CompletionView = {
  id: string;
  completer: { id: string; displayName: string };
  recorder: { id: string; displayName: string };
  method: "manual" | "nfc";
  tagId: string | null;
  completedAt: Date;
  late: boolean;
  /** An Early Completion: recorded before the Occurrence was due. */
  early: boolean;
};

/** A Completion withdrawn by Undo (voidedBy = its Completer) or Void (voidedBy = an Admin). */
export type VoidedCompletionView = CompletionView & {
  voidedAt: Date;
  voidedBy: { id: string; displayName: string };
};

/** Set when an Admin Excused the Occurrence (status Skipped). Null for Pause-Skipped ones. */
export type ExcuseView = {
  note: string;
  excusedAt: Date;
  excusedBy: { id: string; displayName: string };
};

export type OccurrenceView = {
  id: string;
  dueDate: string;
  timeSlot: string | null;
  windowStart: Date;
  dueTime: Date;
  windowEnd: Date | null;
  status: OccurrenceStatus;
  /** Who is expected to complete it, copied from its Time Slot or Chore when created. */
  assignee: PersonRef | null;
  /** The active (non-voided) Completion, if any. */
  completion: CompletionView | null;
  /** Voided Completions, oldest first; they stay in history. */
  voidedCompletions: VoidedCompletionView[];
  excuse: ExcuseView | null;
  /** Set when a Pause Skipped this Occurrence (status Skipped, `excuse` null). */
  skippedByPause: SkippedByPauseView | null;
};

/** The Pause that Skipped an Occurrence; `choreId` null means a Household Pause. */
export type SkippedByPauseView = { id: string; choreId: string | null; startDate: LocalDate; endDate: LocalDate | null };

export type ChoreView = {
  id: string;
  name: string;
  schedule: Schedule;
  /** The Chore's Assignee, used for Occurrences when the Schedule has no Time Slots. */
  assignee: PersonRef | null;
  /** The earliest Open Occurrence whose Window has opened, else the latest opened or Early-Completed one. */
  currentOccurrence: OccurrenceView | null;
  /** The earliest Open Occurrence, else the next one that will fall due (passing over Pauses). */
  nextDue: NextDue | null;
  /**
   * Set while a Chore or Household Pause covers today: `until` is the last
   * paused date of the current run of Pauses, or null if indefinite.
   */
  paused: { until: LocalDate | null } | null;
};

/** `archivedAt` is null for an active Chore; an Archived Chore keeps its history readable here. */
export type ChoreDetailView = ChoreView & { archivedAt: Date | null; occurrences: OccurrenceView[] };

type Scope = { db: Db; membership: CurrentMembership; now: Date };

/** Every non-archived Chore in the Household. */
export async function listChores({ db, membership, now }: Scope): Promise<ChoreView[]> {
  await materialise(db, { householdId: membership.householdId, timeZone: membership.timeZone, now });
  const chores = await db`
    SELECT c.id, c.name, c.schedule, c.assignee_id, ap.display_name AS assignee_name
    FROM chores c LEFT JOIN persons ap ON ap.id = c.assignee_id
    WHERE c.household_id = ${membership.householdId} AND c.archived_at IS NULL
    ORDER BY c.name, c.created_at`;
  const occurrences = await loadOccurrences(db, membership.householdId, null);
  const pauses = await loadPauses(db, membership.householdId);
  return chores.map((c: any) =>
    toChoreView(c, occurrences.filter((o) => o.choreId === c.id), membership.timeZone, now, pausesFor(pauses, c.id)),
  );
}

/** One Chore in the Household with all its Occurrences, or null. */
export async function getChore({ db, membership, now }: Scope, choreId: string): Promise<ChoreDetailView | null> {
  const [chore] = await db`
    SELECT c.id, c.name, c.schedule, c.archived_at, c.assignee_id, ap.display_name AS assignee_name
    FROM chores c LEFT JOIN persons ap ON ap.id = c.assignee_id
    WHERE c.household_id = ${membership.householdId} AND c.id = ${choreId}::uuid`.catch(() => []);
  if (!chore) return null;
  await materialise(db, { householdId: membership.householdId, timeZone: membership.timeZone, now, choreId });
  const occurrences = await loadOccurrences(db, membership.householdId, choreId);
  return {
    ...toChoreView(chore, occurrences, membership.timeZone, now, pausesFor(await loadPauses(db, membership.householdId), choreId)),
    archivedAt: chore.archived_at,
    occurrences: occurrences.map(({ choreId: _, ...o }) => o),
  };
}

function toChoreView(
  chore: any,
  occurrences: (OccurrenceView & { choreId: string })[],
  timeZone: string,
  now: Date,
  pauses: Pause[],
): ChoreView {
  // Opened Occurrences, plus any completed ahead of their Window (Early Completions).
  const opened = occurrences
    .filter((o) => o.windowStart <= now || o.completion !== null)
    .map(({ choreId: _, ...o }) => o);
  const currentOccurrence = opened.find((o) => o.status === "open") ?? opened.at(-1) ?? null;

  const latest = occurrences.at(-1);
  const nextDue = deriveNextDue(
    chore.schedule,
    timeZone,
    occurrences.find((o) => o.status === "open") ?? null,
    latest
      ? {
          windowStart: latest.windowStart,
          windowEnd: latest.windowEnd,
          // Same rule as loadLatestOccurrence: completed, Excused, or Missed or Pause-Skipped (at its Window end).
          closedAt:
            latest.completion?.completedAt ??
            latest.excuse?.excusedAt ??
            (latest.status === "missed" || latest.status === "skipped" ? latest.windowEnd : null),
        }
      : null,
    pauses,
  );
  const through = pausedThrough(pauses, localDateOf(now, timeZone));
  return {
    id: chore.id,
    name: chore.name,
    schedule: chore.schedule,
    assignee: personRef(chore.assignee_id, chore.assignee_name),
    currentOccurrence,
    nextDue,
    paused: through === undefined ? null : { until: through },
  };
}

export function personRef(id: string | null, displayName: string | null): PersonRef | null {
  return id ? { id, displayName: displayName ?? "" } : null;
}

async function loadOccurrences(db: Db, householdId: string, choreId: string | null) {
  const rows = await db`
    SELECT o.id, o.chore_id, o.due_date::text AS due_date, o.time_slot, o.window_start, o.due_time,
           o.window_end, o.status, o.assignee_id, ap.display_name AS assignee_name,
           c.id AS completion_id, c.method, c.tag_id, c.completed_at, c.late, c.early,
           cp.id AS completer_id, cp.display_name AS completer_name,
           rp.id AS recorder_id, rp.display_name AS recorder_name,
           o.excuse_note, o.excused_at, ep.id AS excused_by_id, ep.display_name AS excused_by_name,
           pz.id AS pause_id, pz.chore_id AS pause_chore_id,
           pz.start_date::text AS pause_start_date, pz.end_date::text AS pause_end_date
    FROM occurrences o
    LEFT JOIN pauses pz ON pz.id = o.skipped_by_pause_id
    LEFT JOIN persons ap ON ap.id = o.assignee_id
    LEFT JOIN completions c ON c.occurrence_id = o.id AND c.voided_at IS NULL
    LEFT JOIN persons cp ON cp.id = c.completer_id
    LEFT JOIN persons rp ON rp.id = c.recorder_id
    LEFT JOIN persons ep ON ep.id = o.excused_by
    WHERE o.household_id = ${householdId} AND (${choreId}::uuid IS NULL OR o.chore_id = ${choreId}::uuid)
    ORDER BY o.window_start`;
  const voided = await db`
    SELECT c.occurrence_id, c.id, c.method, c.tag_id, c.completed_at, c.late, c.early, c.voided_at,
           cp.id AS completer_id, cp.display_name AS completer_name,
           rp.id AS recorder_id, rp.display_name AS recorder_name,
           vp.id AS voided_by_id, vp.display_name AS voided_by_name
    FROM completions c
    JOIN occurrences o ON o.id = c.occurrence_id
    JOIN persons cp ON cp.id = c.completer_id
    JOIN persons rp ON rp.id = c.recorder_id
    JOIN persons vp ON vp.id = c.voided_by
    WHERE c.household_id = ${householdId} AND c.voided_at IS NOT NULL
      AND (${choreId}::uuid IS NULL OR o.chore_id = ${choreId}::uuid)
    ORDER BY c.completed_at, c.voided_at`;
  const voidedByOccurrence = new Map<string, VoidedCompletionView[]>();
  for (const v of voided as any[]) {
    const list = voidedByOccurrence.get(v.occurrence_id) ?? [];
    list.push({
      id: v.id,
      completer: { id: v.completer_id, displayName: v.completer_name },
      recorder: { id: v.recorder_id, displayName: v.recorder_name },
      method: v.method,
      tagId: v.tag_id,
      completedAt: v.completed_at,
      late: v.late,
      early: v.early,
      voidedAt: v.voided_at,
      voidedBy: { id: v.voided_by_id, displayName: v.voided_by_name },
    });
    voidedByOccurrence.set(v.occurrence_id, list);
  }
  return rows.map((r: any) => ({
    choreId: r.chore_id as string,
    id: r.id,
    dueDate: r.due_date,
    timeSlot: r.time_slot,
    windowStart: r.window_start,
    dueTime: r.due_time,
    windowEnd: r.window_end,
    status: r.status,
    assignee: personRef(r.assignee_id, r.assignee_name),
    completion: r.completion_id
      ? {
          id: r.completion_id,
          completer: { id: r.completer_id, displayName: r.completer_name },
          recorder: { id: r.recorder_id, displayName: r.recorder_name },
          method: r.method,
          tagId: r.tag_id,
          completedAt: r.completed_at,
          late: r.late,
          early: r.early,
        }
      : null,
    voidedCompletions: voidedByOccurrence.get(r.id) ?? [],
    excuse: r.excused_at
      ? {
          note: r.excuse_note,
          excusedAt: r.excused_at,
          excusedBy: { id: r.excused_by_id, displayName: r.excused_by_name },
        }
      : null,
    skippedByPause: r.pause_id
      ? { id: r.pause_id, choreId: r.pause_chore_id, startDate: r.pause_start_date, endDate: r.pause_end_date }
      : null,
  })) as (OccurrenceView & { choreId: string })[];
}

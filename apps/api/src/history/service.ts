/**
 * History read model: the accountability views.
 *
 * Names are resolved by joining `persons` directly, never through current
 * Memberships, so a Person whose Membership has ended keeps their name here.
 * Materialises first, so Missed and Pause-Skipped outcomes are up to date.
 */
import type { Db } from "../db/client";
import type { CurrentMembership } from "../households/access";
import { materialise } from "../occurrences/materialise";
import { addDays, startOfLocalDay, type LocalDate } from "../schedule/calendar";
import { personRef, type PersonRef } from "../chores/views";

export type HistoryCompletion = {
  id: string;
  chore: { id: string; name: string };
  occurrence: { id: string; dueDate: LocalDate; timeSlot: string | null; assignee: PersonRef | null };
  method: "manual" | "nfc";
  /** The Tag scanned, for Method NFC. */
  tagId: string | null;
  completer: PersonRef;
  /** Who entered it; differs from the Completer only for a Completion recorded on someone's behalf. */
  recorder: PersonRef;
  completedAt: Date;
  late: boolean;
  early: boolean;
  /** Set for a voided Completion (Undo: `by` is the Completer; Void: an Admin). */
  voided: { at: Date; by: PersonRef } | null;
};

export type AssignedOutcome = "on_time" | "late" | "by_someone_else" | "missed" | "skipped";

export type SkipReason =
  | { reason: "excused"; note: string; excusedAt: Date; excusedBy: PersonRef }
  | { reason: "pause"; pause: { id: string; choreId: string | null; startDate: LocalDate; endDate: LocalDate | null } };

export type AssignedOccurrence = {
  occurrenceId: string;
  chore: { id: string; name: string };
  dueDate: LocalDate;
  timeSlot: string | null;
  dueTime: Date;
  outcome: AssignedOutcome;
  /** The active Completion for on_time, late and by_someone_else; otherwise null. */
  completion: HistoryCompletion | null;
  /** Why it was Skipped; null for other outcomes. */
  skip: SkipReason | null;
};

export type PersonHistory = {
  person: PersonRef;
  from: LocalDate;
  to: LocalDate;
  /** Occurrences assigned to the Person, due within the range, that have an outcome (Open ones are left out). */
  assigned: AssignedOccurrence[];
  /** The Person's active Completions, made within the range, on Occurrences unassigned or assigned to others. */
  otherCompletions: HistoryCompletion[];
};

export type HouseholdHistory = { from: LocalDate; to: LocalDate; completions: HistoryCompletion[] };

type Scope = { db: Db; membership: CurrentMembership; now: Date };
export type DateRange = { from: LocalDate; to: LocalDate };

/** Completions (voided ones included) made within the range, in the Household zone, newest first. */
export async function householdHistory({ db, membership, now }: Scope, range: DateRange): Promise<HouseholdHistory> {
  await materialise(db, { householdId: membership.householdId, timeZone: membership.timeZone, now });
  const rows = await loadCompletions(db, { householdId: membership.householdId, timeZone: membership.timeZone, range });
  return { ...range, completions: rows.map(toCompletion) };
}

/**
 * One Person's history, or null when the Person has never had a Membership in
 * this Household (current or ended).
 */
/** A Person whose history can be viewed: anyone who ever had a Membership in the Household. */
export type HistoryPerson = { id: string; displayName: string; current: boolean };

/** Everyone who ever had a Membership in the Household, current ones first, then by name. */
export async function historyPersons(db: Db, householdId: string): Promise<HistoryPerson[]> {
  const rows = await db`
    SELECT p.id, p.display_name, bool_or(m.ended_at IS NULL) AS current
    FROM memberships m JOIN persons p ON p.id = m.person_id
    WHERE m.household_id = ${householdId}
    GROUP BY p.id, p.display_name
    ORDER BY bool_or(m.ended_at IS NULL) DESC, p.display_name, p.id`;
  return rows.map((r: any) => ({ id: r.id, displayName: r.display_name, current: r.current }));
}

export async function personHistory(
  { db, membership, now }: Scope,
  personId: string,
  range: DateRange,
): Promise<PersonHistory | null> {
  const { householdId, timeZone } = membership;
  const [person] = await db`
    SELECT p.id, p.display_name FROM persons p
    WHERE p.id::text = ${personId}
      AND EXISTS (SELECT 1 FROM memberships m WHERE m.person_id = p.id AND m.household_id = ${householdId})`;
  if (!person) return null;

  await materialise(db, { householdId, timeZone, now });

  const occurrences = await db`
    SELECT o.id, o.due_date::text AS due_date, o.time_slot, o.due_time, o.status,
           ch.id AS chore_id, ch.name AS chore_name,
           c.id AS id_completion, c.method, c.tag_id, c.completed_at, c.late, c.early, c.voided_at,
           ${person.id}::uuid AS assignee_id, ${person.display_name}::text AS assignee_name,
           cp.id AS completer_id, cp.display_name AS completer_name,
           rp.id AS recorder_id, rp.display_name AS recorder_name,
           NULL::uuid AS voided_by_id, NULL::text AS voided_by_name,
           o.excuse_note, o.excused_at, ep.id AS excused_by_id, ep.display_name AS excused_by_name,
           pz.id AS pause_id, pz.chore_id AS pause_chore_id,
           pz.start_date::text AS pause_start_date, pz.end_date::text AS pause_end_date
    FROM occurrences o
    JOIN chores ch ON ch.id = o.chore_id
    LEFT JOIN completions c ON c.occurrence_id = o.id AND c.voided_at IS NULL
    LEFT JOIN persons cp ON cp.id = c.completer_id
    LEFT JOIN persons rp ON rp.id = c.recorder_id
    LEFT JOIN persons ep ON ep.id = o.excused_by
    LEFT JOIN pauses pz ON pz.id = o.skipped_by_pause_id
    WHERE o.household_id = ${householdId} AND o.assignee_id = ${person.id}
      AND o.status <> 'open'
      AND o.due_date BETWEEN ${range.from}::date AND ${range.to}::date
    ORDER BY o.due_date, o.window_start`;

  const others = await loadCompletions(db, { householdId, timeZone, range, extraFor: person.id });

  return {
    person: { id: person.id, displayName: person.display_name },
    ...range,
    assigned: occurrences.map((o: any): AssignedOccurrence => {
      const completion = o.id_completion ? toCompletion({ ...o, id: o.id_completion, occurrence_id: o.id }) : null;
      return {
        occurrenceId: o.id,
        chore: { id: o.chore_id, name: o.chore_name },
        dueDate: o.due_date,
        timeSlot: o.time_slot,
        dueTime: o.due_time,
        outcome: outcomeOf(o.status, completion, person.id),
        completion,
        skip: skipOf(o),
      };
    }),
    otherCompletions: others.map(toCompletion),
  };
}

function outcomeOf(status: string, completion: HistoryCompletion | null, personId: string): AssignedOutcome {
  if (status === "missed") return "missed";
  if (status === "skipped") return "skipped";
  if (completion!.completer.id !== personId) return "by_someone_else";
  return completion!.late ? "late" : "on_time";
}

function skipOf(o: any): SkipReason | null {
  if (o.excused_at) {
    return {
      reason: "excused",
      note: o.excuse_note,
      excusedAt: o.excused_at,
      excusedBy: { id: o.excused_by_id, displayName: o.excused_by_name },
    };
  }
  if (o.pause_id) {
    return {
      reason: "pause",
      pause: { id: o.pause_id, choreId: o.pause_chore_id, startDate: o.pause_start_date, endDate: o.pause_end_date },
    };
  }
  return null;
}

type CompletionFilter = {
  householdId: string;
  timeZone: string;
  range: DateRange;
  /** Only this Completer's active Completions on Occurrences not assigned to them. */
  extraFor?: string;
};

/** Completions made within the range (local dates in the Household zone). */
function loadCompletions(db: Db, f: CompletionFilter) {
  const extraFor = f.extraFor ?? null;
  return db`
    SELECT c.id, c.method, c.tag_id, c.completed_at, c.late, c.early, c.voided_at,
           ch.id AS chore_id, ch.name AS chore_name,
           o.id AS occurrence_id, o.due_date::text AS due_date, o.time_slot,
           ap.id AS assignee_id, ap.display_name AS assignee_name,
           cp.id AS completer_id, cp.display_name AS completer_name,
           rp.id AS recorder_id, rp.display_name AS recorder_name,
           vp.id AS voided_by_id, vp.display_name AS voided_by_name
    FROM completions c
    JOIN occurrences o ON o.id = c.occurrence_id
    JOIN chores ch ON ch.id = o.chore_id
    JOIN persons cp ON cp.id = c.completer_id
    JOIN persons rp ON rp.id = c.recorder_id
    LEFT JOIN persons ap ON ap.id = o.assignee_id
    LEFT JOIN persons vp ON vp.id = c.voided_by
    WHERE c.household_id = ${f.householdId}
      AND c.completed_at >= ${startOfLocalDay(f.range.from, f.timeZone)}
      AND c.completed_at < ${startOfLocalDay(addDays(f.range.to, 1), f.timeZone)}
      AND (${extraFor}::uuid IS NULL OR (
        c.completer_id = ${extraFor}::uuid AND c.voided_at IS NULL
        AND (o.assignee_id IS NULL OR o.assignee_id <> ${extraFor}::uuid)))
    ORDER BY c.completed_at DESC, c.id`;
}

function toCompletion(r: any): HistoryCompletion {
  return {
    id: r.id,
    chore: { id: r.chore_id, name: r.chore_name },
    occurrence: { id: r.occurrence_id, dueDate: r.due_date, timeSlot: r.time_slot, assignee: personRef(r.assignee_id, r.assignee_name) },
    method: r.method,
    tagId: r.tag_id,
    completer: { id: r.completer_id, displayName: r.completer_name },
    recorder: { id: r.recorder_id, displayName: r.recorder_name },
    completedAt: r.completed_at,
    late: r.late,
    early: r.early,
    voided: r.voided_at ? { at: r.voided_at, by: { id: r.voided_by_id, displayName: r.voided_by_name } } : null,
  };
}

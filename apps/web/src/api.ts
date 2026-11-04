// Thin JSON client for the backend API. All requests are same-origin (/api)
// so the HttpOnly session cookie is sent automatically.

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API ${status}`);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init.headers },
  });
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export type Me = {
  person: { id: string; displayName: string; email: string | null };
  memberships: {
    role: "admin" | "standard";
    household: { id: string; name: string; timeZone: string };
  }[];
};

export type OccurrenceStatus = "open" | "completed" | "missed" | "skipped";

export type PersonRef = { id: string; displayName: string };

export type Completion = {
  id: string;
  completer: PersonRef;
  recorder: PersonRef;
  /** The Occurrence's Assignee (on complete and scan results). */
  assignee?: PersonRef | null;
  timeSlot?: string | null;
  method: "manual" | "nfc";
  completedAt: string;
  late: boolean;
  /** An Early Completion: recorded before the Occurrence was due. */
  early: boolean;
};

/** A Completion withdrawn by Undo or Void; it stays in history. */
export type VoidedCompletion = Completion & { voidedAt: string; voidedBy: { id: string; displayName: string } };

/** Set when an Admin Excused the Occurrence (status Skipped). */
export type Excuse = { note: string; excusedAt: string; excusedBy: { id: string; displayName: string } };

/** GET /households/:id/persons */
export type HouseholdPerson = { id: string; displayName: string; role: "admin" | "standard" };

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type FixedRule =
  | { type: "every_n_days"; n: number }
  | { type: "weekdays"; weekdays: Weekday[]; n: number }
  | { type: "monthly"; day: number };

/** A named time of day ("HH:MM") within a Fixed Schedule, each producing its own Occurrence. */
export type TimeSlot = { name: string; start: string; assigneeId: string | null };

/** Mirrors the backend Schedule engine's definition. */
export type Schedule =
  | { kind: "fixed"; startDate: string; rule: FixedRule; slots?: TimeSlot[] }
  | { kind: "interval"; startDate: string; periodDays: number }
  | { kind: "one_off"; dueDate: string };

export type Chore = {
  id: string;
  name: string;
  schedule: Schedule;
  /** Copied onto Occurrences when the Schedule has no Time Slots. */
  assignee: PersonRef | null;
  currentOccurrence: {
    id: string;
    dueDate: string;
    timeSlot: string | null;
    assignee: PersonRef | null;
    status: OccurrenceStatus;
    completion: Completion | null;
    voidedCompletions: VoidedCompletion[];
    excuse: Excuse | null;
    /** Set when a Pause Skipped it (excuse is then null). */
    skippedByPause: { id: string; choreId: string | null; startDate: string; endDate: string | null } | null;
  } | null;
  /** The next Occurrence; what "Complete early" names in its request. */
  nextDue: { dueDate: string; timeSlot: string | null; dueTime: string } | null;
  /**
   * Set while a Pause covers today; `until` is the last paused date (null: indefinite).
   * `completeAnyway` is the Occurrence "Complete anyway" names (even under an indefinite Pause).
   */
  paused: { until: string | null; completeAnyway: Chore["nextDue"] } | null;
};

/** GET /households/:id/pauses. Mirrors PauseView in apps/api/src/pauses/service.ts. */
export type Pause = {
  id: string;
  /** null: a Household Pause. */
  chore: ChoreRef | null;
  startDate: string;
  /** Last paused date (inclusive); null: indefinite. */
  endDate: string | null;
  plannedEndDate: string | null;
  createdAt: string;
  createdBy: PersonRef;
  endedEarlyAt: string | null;
  endedEarlyBy: PersonRef | null;
  state: "upcoming" | "current" | "past";
};

export type CompleteResult =
  | { outcome: "completed" | "already_completed"; completion: Completion; nextDue: Chore["nextDue"] }
  | { outcome: "nothing_due"; nextDue: Chore["nextDue"] };

export type Tag = {
  id: string;
  /** The permanent path written onto the physical Tag (ADR 0001). */
  path: string;
  chore: { id: string; name: string } | null;
};

export type ChoreRef = { id: string; name: string };

/** POST /api/scan/:tagId. Mirrors ScanOutcome in apps/api/src/scan/resolver.ts. */
export type ScanOutcome =
  | { outcome: "completed"; chore: ChoreRef; completion: Completion; nextDue: Chore["nextDue"] }
  | {
      outcome: "already_completed";
      chore: ChoreRef;
      completion: Completion;
      nextDue: Chore["nextDue"];
      earlyCompletionOffered: boolean;
    }
  | { outcome: "nothing_due"; chore: ChoreRef; nextDue: Chore["nextDue"]; earlyCompletionOffered: boolean }
  | {
      outcome: "paused";
      chore: ChoreRef;
      until: string | null;
      nextDue: Chore["nextDue"];
      completeAnywayOffered: boolean;
    }
  | { outcome: "tag_unlinked"; householdId: string; canLink: boolean }
  | { outcome: "tag_unregistered"; canClaim: boolean; households: { id: string; name: string }[] }
  | { outcome: "not_a_member" };

/** A Completion in the history views. Mirrors HistoryCompletion in apps/api/src/history/service.ts. */
export type HistoryCompletion = {
  id: string;
  chore: { id: string; name: string };
  occurrence: { id: string; dueDate: string; timeSlot: string | null; assignee: PersonRef | null };
  method: "manual" | "nfc";
  tagId: string | null;
  completer: PersonRef;
  recorder: PersonRef;
  completedAt: string;
  late: boolean;
  early: boolean;
  voided: { at: string; by: PersonRef } | null;
};

/** GET /households/:id/history */
export type HouseholdHistory = { from: string; to: string; completions: HistoryCompletion[] };

export type AssignedOutcome = "on_time" | "late" | "by_someone_else" | "missed" | "skipped";

export type SkipReason =
  | { reason: "excused"; note: string; excusedAt: string; excusedBy: PersonRef }
  | { reason: "pause"; pause: { id: string; choreId: string | null; startDate: string; endDate: string | null } };

/** GET /households/:id/history/persons/:personId */
export type PersonHistory = {
  person: PersonRef;
  from: string;
  to: string;
  assigned: {
    occurrenceId: string;
    chore: { id: string; name: string };
    dueDate: string;
    timeSlot: string | null;
    dueTime: string;
    outcome: AssignedOutcome;
    completion: HistoryCompletion | null;
    skip: SkipReason | null;
  }[];
  otherCompletions: HistoryCompletion[];
};

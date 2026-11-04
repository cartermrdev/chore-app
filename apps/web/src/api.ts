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
  person: { id: string; displayName: string };
  memberships: {
    role: "admin" | "standard";
    household: { id: string; name: string; timeZone: string };
  }[];
};

export type OccurrenceStatus = "open" | "completed" | "missed" | "skipped";

export type Completion = {
  id: string;
  completer: { id: string; displayName: string };
  recorder: { id: string; displayName: string };
  method: "manual" | "nfc";
  completedAt: string;
  late: boolean;
};

export type Chore = {
  id: string;
  name: string;
  currentOccurrence: {
    id: string;
    dueDate: string;
    status: OccurrenceStatus;
    completion: Completion | null;
  } | null;
  nextDue: { dueDate: string; dueTime: string } | null;
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
  | { outcome: "completed" | "already_completed"; chore: ChoreRef; completion: Completion; nextDue: Chore["nextDue"] }
  | { outcome: "nothing_due"; chore: ChoreRef; nextDue: Chore["nextDue"]; earlyCompletionOffered: boolean }
  | { outcome: "tag_unlinked"; householdId: string; canLink: boolean }
  | { outcome: "not_a_member" };

import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type Chore, type ScanOutcome, type Tag } from "../api";
import { UndoButton } from "./corrections";

/** Automatic retries after the first attempt: 1 s, 3 s, 6 s (about 10 s), then a Retry button. */
const RETRY_DELAYS_MS = [1000, 3000, 6000];
const ATTEMPT_TIMEOUT_MS = 5000;

/** Network failures, timeouts and 5xx are worth retrying; a definite answer (4xx) is not. */
function isTransient(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

/**
 * The page behind the permanent Tag URL /nfc/{tagId} (ADR 0001). Loading it
 * changes nothing by itself; on mount it sends one POST to the Scan resolver
 * with an idempotency key generated once per page and reused by every retry,
 * so a retried request can never record twice. Success is shown only from the
 * backend's answer.
 */
export function ScanPage({ tagId }: { tagId: string }) {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const scan = useMutation({
    mutationFn: () =>
      api<ScanOutcome>(`/scan/${encodeURIComponent(tagId)}`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey }),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      }),
    retry: (failures, error) => failures < RETRY_DELAYS_MS.length && isTransient(error),
    retryDelay: (failures) => RETRY_DELAYS_MS[failures] ?? RETRY_DELAYS_MS.at(-1)!,
  });

  // Exactly one automatic scan per page load (StrictMode runs effects twice in dev).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    scan.mutate();
  }, [scan]);

  if (scan.isSuccess) return <OutcomeScreen result={scan.data} tagId={tagId} />;
  if (scan.isError) {
    const err = scan.error;
    if (err instanceof ApiError && err.status === 401) return <Screen title="Sign in to continue" />;
    if (err instanceof ApiError && err.status === 404) return <Screen title="This tag isn't recognised" />;
    return (
      <Screen title="Couldn't record the scan">
        <p role="alert">We couldn't reach the server. Nothing has been recorded yet.</p>
        <button type="button" onClick={() => scan.mutate()}>
          Retry
        </button>
      </Screen>
    );
  }
  return <Screen title={scan.failureCount > 0 ? "Retrying…" : "Recording…"} />;
}

function OutcomeScreen({ result, tagId }: { result: ScanOutcome; tagId: string }) {
  switch (result.outcome) {
    case "completed":
      return <CompletedScreen result={result} />;
    case "already_completed": {
      const c = result.completion;
      return (
        <Screen title={result.chore.name} mark="✓">
          <p>
            Already completed by {c.completer.displayName} at {formatTime(c.completedAt)}
          </p>
          <p>
            <NextDue nextDue={result.nextDue} />
          </p>
        </Screen>
      );
    }
    case "nothing_due":
      return (
        <Screen title={result.chore.name}>
          <p>Nothing is due right now.</p>
          <p>
            <NextDue nextDue={result.nextDue} />
          </p>
        </Screen>
      );
    case "tag_unlinked":
      return (
        <Screen title="This tag isn't linked to a chore">
          {result.canLink ? (
            <LinkTag tagId={tagId} householdId={result.householdId} />
          ) : (
            <p>Ask an admin to link it.</p>
          )}
        </Screen>
      );
    case "tag_unregistered":
      return result.canClaim ? (
        <Screen title="Register this tag">
          <ClaimTag tagId={tagId} households={result.households} />
        </Screen>
      ) : (
        <Screen title="This tag isn't set up yet">
          <p>Ask an admin to register it.</p>
        </Screen>
      );
    case "not_a_member":
      return (
        <Screen title="Not a member">
          <p>You aren't a member of the household this tag belongs to.</p>
        </Screen>
      );
  }
}

/** The confirmation, with Undo for the Completer for 5 minutes. */
function CompletedScreen({ result }: { result: Extract<ScanOutcome, { outcome: "completed" | "already_completed" }> }) {
  const [undone, setUndone] = useState(false);
  const c = result.completion;
  if (undone) {
    return (
      <Screen title={result.chore.name}>
        <p>Undone. Nothing is recorded for this scan.</p>
      </Screen>
    );
  }
  return (
    <Screen title={result.chore.name} mark="✓">
      <p>Credited to {c.completer.displayName}</p>
      <p>
        {c.late ? "Late" : "On time"}
        <NextDue nextDue={result.nextDue} prefix=" · " />
      </p>
      <UndoButton completionId={c.id} completedAt={c.completedAt} onUndone={() => setUndone(true)} />
    </Screen>
  );
}

/** Admin shortcut on the unlinked-tag screen: point this Tag at a Chore without leaving the page. */
function LinkTag({ tagId, householdId }: { tagId: string; householdId: string }) {
  const [open, setOpen] = useState(false);
  const link = useMutation({
    mutationFn: (choreId: string) =>
      api<Tag>(`/households/${householdId}/tags/${encodeURIComponent(tagId)}`, {
        method: "PATCH",
        body: JSON.stringify({ choreId }),
      }),
  });
  if (link.isSuccess) return <Linked tag={link.data} />;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Link to a chore
      </button>
    );
  }
  return (
    <ChorePicker
      householdId={householdId}
      action="Link"
      pending={link.isPending}
      failed={link.isError}
      onPick={(choreId) => link.mutate(choreId)}
    />
  );
}

/**
 * Admin flow for an Unregistered Tag: choose the Household (when the Admin
 * has several) and a Chore, then claim the scanned ID in one request.
 */
function ClaimTag({ tagId, households }: { tagId: string; households: { id: string; name: string }[] }) {
  const [householdId, setHouseholdId] = useState(households[0]!.id);
  const claim = useMutation({
    mutationFn: (choreId: string) =>
      api<Tag>(`/households/${householdId}/tags/${encodeURIComponent(tagId)}/claim`, {
        method: "POST",
        body: JSON.stringify({ choreId }),
      }),
  });
  if (claim.isSuccess) return <Linked tag={claim.data} />;
  return (
    <>
      {households.length > 1 && (
        <p>
          <label>
            Household{" "}
            <select value={householdId} onChange={(e) => setHouseholdId(e.target.value)}>
              {households.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>
        </p>
      )}
      <ChorePicker
        key={householdId}
        householdId={householdId}
        action="Register tag"
        pending={claim.isPending}
        failed={claim.isError}
        onPick={(choreId) => claim.mutate(choreId)}
      />
    </>
  );
}

function ChorePicker(props: {
  householdId: string;
  action: string;
  pending: boolean;
  failed: boolean;
  onPick: (choreId: string) => void;
}) {
  const chores = useQuery({
    queryKey: ["chores", props.householdId],
    queryFn: () => api<{ chores: Chore[] }>(`/households/${props.householdId}/chores`),
  });
  const [choreId, setChoreId] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (choreId) props.onPick(choreId);
  };
  if (chores.isError) return <p role="alert">Could not load chores.</p>;
  if (chores.data?.chores.length === 0) return <p>Add a chore first, then scan this tag again.</p>;
  return (
    <form onSubmit={submit}>
      <label>
        Chore{" "}
        <select value={choreId} onChange={(e) => setChoreId(e.target.value)} required>
          <option value="">Choose a chore…</option>
          {chores.data?.chores.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>{" "}
      <button type="submit" disabled={props.pending || !choreId}>
        {props.action}
      </button>
      {props.failed && <p role="alert">That didn't work. Try again.</p>}
    </form>
  );
}

function Linked({ tag }: { tag: Tag }) {
  return (
    <>
      <p>This tag now completes {tag.chore?.name ?? "no chore"}.</p>
      <p>Scan it again to complete the chore.</p>
    </>
  );
}

function Screen({ title, mark, children }: { title: string; mark?: string; children?: React.ReactNode }) {
  return (
    <section>
      {mark && (
        <p style={{ fontSize: "6rem", margin: 0 }} aria-label="Done">
          {mark}
        </p>
      )}
      <h1>{title}</h1>
      {children}
    </section>
  );
}

function NextDue({ nextDue, prefix = "" }: { nextDue: Chore["nextDue"]; prefix?: string }) {
  if (!nextDue) return null;
  return (
    <span>
      {prefix}Next due {formatDate(nextDue.dueDate)}
    </span>
  );
}

/** A due date ("YYYY-MM-DD") is a calendar date, so format it without shifting zones. */
function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

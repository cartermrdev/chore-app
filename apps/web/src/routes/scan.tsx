import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Chore, type ScanOutcome } from "../api";

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

  if (scan.isSuccess) return <OutcomeScreen result={scan.data} />;
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

function OutcomeScreen({ result }: { result: ScanOutcome }) {
  switch (result.outcome) {
    case "completed": {
      const c = result.completion;
      return (
        <Screen title={result.chore.name} mark="✓">
          <p>Credited to {c.completer.displayName}</p>
          <p>
            {c.late ? "Late" : "On time"}
            <NextDue nextDue={result.nextDue} prefix=" · " />
          </p>
        </Screen>
      );
    }
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
          {result.canLink ? <Link to="/">Link to a chore</Link> : <p>Ask an admin to link it.</p>}
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

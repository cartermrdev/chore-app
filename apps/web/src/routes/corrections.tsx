import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type HouseholdPerson } from "../api";

/**
 * Undo for the Completer's own Completion. Shown for `remainingMs` (the Undo
 * time left, as the backend counted it when it answered) from when it first
 * renders, then hidden, so a wrong phone clock can't hide or keep it. Calls
 * `onUndone` once the backend confirms; the backend enforces the window.
 */
export function UndoButton({ completionId, remainingMs, onUndone }: { completionId: string; remainingMs: number; onUndone: () => void }) {
  const [expired, setExpired] = useState(() => remainingMs <= 0);
  useEffect(() => {
    if (expired) return;
    // A relative timer from the server's figure: only elapsed time matters, never the phone's date.
    const timer = setTimeout(() => setExpired(true), remainingMs);
    return () => clearTimeout(timer);
    // Count from first render only; a re-render must not restart the countdown.
  }, [expired]);

  const undo = useMutation({
    mutationFn: () => api(`/completions/${completionId}/undo`, { method: "POST" }),
    onSuccess: onUndone,
  });

  const rejected = undo.error instanceof ApiError && undo.error.status < 500;
  if (expired || rejected) {
    return rejected ? <p role="alert">This can no longer be undone.</p> : null;
  }
  return (
    <>
      <button type="button" disabled={undo.isPending} onClick={() => undo.mutate()}>
        Undo
      </button>
      {undo.error && <span role="alert"> Could not undo. Try again.</span>}
    </>
  );
}

/** The Household's current Persons (for the Admin's "Complete for" picker). */
export function useHouseholdPersons(householdId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["persons", householdId],
    queryFn: () => api<{ persons: HouseholdPerson[] }>(`/households/${householdId}/persons`),
    enabled,
  });
}

/** Admin only: choose who to credit. "" means the signed-in Person. */
export function CompleterPicker({ householdId, value, onChange }: { householdId: string; value: string; onChange: (id: string) => void }) {
  const persons = useHouseholdPersons(householdId, true);
  return (
    <label>
      Complete for{" "}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">(me)</option>
        {persons.data?.persons.map((p) => (
          <option key={p.id} value={p.id}>
            {p.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Admin only: Void the active Completion. */
export function VoidButton({ householdId, completionId }: { householdId: string; completionId: string }) {
  const queryClient = useQueryClient();
  const voidIt = useMutation({
    mutationFn: () => api(`/completions/${completionId}/void`, { method: "POST" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["chores", householdId] }),
  });
  return (
    <>
      <button type="button" disabled={voidIt.isPending} onClick={() => voidIt.mutate()}>
        Void
      </button>
      {voidIt.error && <span role="alert"> Could not void.</span>}
    </>
  );
}

/** Admin only: Excuse an Open or Missed Occurrence with a note (it becomes Skipped). */
export function ExcuseForm({ householdId, occurrenceId }: { householdId: string; occurrenceId: string }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const excuse = useMutation({
    mutationFn: () => api(`/occurrences/${occurrenceId}/excuse`, { method: "POST", body: JSON.stringify({ note }) }),
    onSuccess: () => setNote(""),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["chores", householdId] }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    excuse.mutate();
  };
  return (
    <form aria-label="Excuse" onSubmit={submit} style={{ display: "inline" }}>
      <label>
        Excuse note <input value={note} onChange={(e) => setNote(e.target.value)} required maxLength={500} />
      </label>{" "}
      <button type="submit" disabled={excuse.isPending}>
        Excuse
      </button>
      {excuse.error && <span role="alert"> Could not excuse.</span>}
    </form>
  );
}

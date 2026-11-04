import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type HouseholdPerson } from "../api";

/** Mirrors UNDO_WINDOW_MS in apps/api/src/completions/corrections.ts. The backend enforces it. */
export const UNDO_WINDOW_MS = 5 * 60_000;

/**
 * Undo for the Completer's own Completion. Shown until 5 minutes after
 * `completedAt`, then hidden. Calls `onUndone` once the backend confirms.
 */
export function UndoButton({ completionId, completedAt, onUndone }: { completionId: string; completedAt: string; onUndone: () => void }) {
  const deadline = new Date(completedAt).getTime() + UNDO_WINDOW_MS;
  const [expired, setExpired] = useState(() => Date.now() >= deadline);
  useEffect(() => {
    if (expired) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline, expired]);

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

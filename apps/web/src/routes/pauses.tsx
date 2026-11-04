import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, ApiError, type Chore, type Pause } from "../api";

const STATE_LABEL = { upcoming: "Upcoming", current: "Current", past: "Past" } as const;

const ERRORS: Record<string, string> = {
  start_in_past: "A pause can't start in the past.",
  invalid_dates: "The end date must be on or after the start date.",
  chore_not_found: "That chore can't be paused.",
};

/**
 * The Household's Pauses, current, upcoming and past (visible to everyone).
 * Admins add a Chore or Household Pause and can end one early.
 */
export function PauseManager({ householdId, isAdmin }: { householdId: string; isAdmin: boolean }) {
  const pauses = useQuery({
    queryKey: ["pauses", householdId],
    queryFn: () => api<{ pauses: Pause[] }>(`/households/${householdId}/pauses`),
  });
  return (
    <section aria-label="Pauses">
      <h2>Pauses</h2>
      {isAdmin && <AddPauseForm householdId={householdId} />}
      {pauses.error && <p role="alert">Could not load pauses.</p>}
      {pauses.data && pauses.data.pauses.length === 0 && <p>No pauses.</p>}
      {pauses.data && pauses.data.pauses.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>What</th>
              <th>From</th>
              <th>Until</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pauses.data.pauses.map((p) => (
              <PauseRow key={p.id} householdId={householdId} pause={p} isAdmin={isAdmin} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PauseRow({ householdId, pause, isAdmin }: { householdId: string; pause: Pause; isAdmin: boolean }) {
  const invalidate = useInvalidate(householdId);
  const end = useMutation({
    mutationFn: () => api<Pause>(`/households/${householdId}/pauses/${pause.id}/end`, { method: "POST" }),
    onSettled: invalidate,
  });
  return (
    <tr>
      <td>{pause.chore?.name ?? "Whole household"}</td>
      <td>{pause.startDate}</td>
      <td>{pause.endedEarlyAt ? pause.plannedEndDate ?? "No end date" : pause.endDate ?? "No end date"}</td>
      <td>
        {STATE_LABEL[pause.state]}
        {pause.endedEarlyBy && ` · Ended early by ${pause.endedEarlyBy.displayName}`} · Added by {pause.createdBy.displayName}
      </td>
      <td>
        {isAdmin && pause.state !== "past" && (
          <button type="button" disabled={end.isPending} onClick={() => end.mutate()}>
            End now
          </button>
        )}
        {end.isError && <span role="alert"> Could not end it.</span>}
      </td>
    </tr>
  );
}

function AddPauseForm({ householdId }: { householdId: string }) {
  const chores = useQuery({
    queryKey: ["chores", householdId],
    queryFn: () => api<{ chores: Chore[] }>(`/households/${householdId}/chores`),
  });
  const invalidate = useInvalidate(householdId);
  const [choreId, setChoreId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const add = useMutation({
    mutationFn: () =>
      api<Pause>(`/households/${householdId}/pauses`, {
        method: "POST",
        body: JSON.stringify({
          choreId: choreId || null,
          ...(startDate ? { startDate } : {}),
          endDate: endDate || null,
        }),
      }),
    onSuccess: () => {
      setStartDate("");
      setEndDate("");
    },
    onSettled: invalidate,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  const error = add.error instanceof ApiError ? ERRORS[(add.error.body as any)?.error] : undefined;
  return (
    <form onSubmit={submit}>
      <label>
        Pause{" "}
        <select value={choreId} onChange={(e) => setChoreId(e.target.value)}>
          <option value="">Whole household</option>
          {chores.data?.chores.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>{" "}
      <label>
        From (default today) <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
      </label>{" "}
      <label>
        Until (optional) <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
      </label>{" "}
      <button type="submit" disabled={add.isPending}>
        Add pause
      </button>
      {add.isError && <span role="alert"> {error ?? "Could not add the pause."}</span>}
    </form>
  );
}

function useInvalidate(householdId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["pauses", householdId] }),
      queryClient.invalidateQueries({ queryKey: ["chores", householdId] }),
    ]);
}

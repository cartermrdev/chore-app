import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { api, ApiError, type Chore, type CompleteResult } from "../api";

const STATUS_LABEL = { open: "Open", completed: "Completed", missed: "Missed", skipped: "Skipped" } as const;

/** The Household's Chores with their current status, next due date and a Complete button. */
export function ChoreList({ householdId, isAdmin }: { householdId: string; isAdmin: boolean }) {
  const chores = useQuery({
    queryKey: ["chores", householdId],
    queryFn: () => api<{ chores: Chore[] }>(`/households/${householdId}/chores`),
  });

  return (
    <section>
      <h2>Chores</h2>
      {isAdmin && <AddChoreForm householdId={householdId} />}
      {chores.isPending && <p>Loading…</p>}
      {chores.error && <p role="alert">Could not load chores.</p>}
      {chores.data && chores.data.chores.length === 0 && <p>No chores yet.</p>}
      <ul>
        {chores.data?.chores.map((chore) => <ChoreRow key={chore.id} householdId={householdId} chore={chore} isAdmin={isAdmin} />)}
      </ul>
    </section>
  );
}

function ChoreRow({ householdId, chore, isAdmin }: { householdId: string; chore: Chore; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  // One key per press of the button, reused if the request is retried.
  const key = useRef<string | null>(null);
  const complete = useMutation({
    mutationFn: () => {
      key.current ??= crypto.randomUUID();
      return api<CompleteResult>(`/households/${householdId}/chores/${chore.id}/complete`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: key.current }),
      });
    },
    retry: 2,
    onSettled: () => {
      key.current = null;
      return queryClient.invalidateQueries({ queryKey: ["chores", householdId] });
    },
  });

  const occ = chore.currentOccurrence;
  return (
    <li>
      <strong>{chore.name}</strong>{" "}
      {occ ? <span>{STATUS_LABEL[occ.status]}</span> : <span>Not due yet</span>}
      {occ?.completion && (
        <span>
          {" "}
          · Completed by {occ.completion.completer.displayName}
          {occ.completion.late ? " (Late)" : ""}
        </span>
      )}
      {chore.nextDue && <span> · Next due {chore.nextDue.dueDate}</span>}{" "}
      {occ?.status === "open" && (
        <button type="button" disabled={complete.isPending} onClick={() => complete.mutate()}>
          Complete
        </button>
      )}
      {complete.error && <span role="alert"> Could not complete. Try again.</span>}
      {isAdmin && <ChoreAdminActions householdId={householdId} chore={chore} />}
    </li>
  );
}

/**
 * Admin-only: Archive (always allowed; keeps history and unlinks the Chore's
 * Tags) and Delete (only for a Chore with no history; the API answers 409
 * otherwise).
 */
function ChoreAdminActions({ householdId, chore }: { householdId: string; chore: Chore }) {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["chores", householdId] }),
      queryClient.invalidateQueries({ queryKey: ["tags", householdId] }),
    ]);
  const archive = useMutation({
    mutationFn: () => api(`/households/${householdId}/chores/${chore.id}/archive`, { method: "POST" }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api(`/households/${householdId}/chores/${chore.id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const busy = archive.isPending || remove.isPending;
  return (
    <>
      {" "}
      <button type="button" disabled={busy} onClick={() => archive.mutate()}>
        Archive
      </button>{" "}
      <button type="button" disabled={busy} onClick={() => remove.mutate()}>
        Delete
      </button>
      {archive.error && <span role="alert"> Could not archive.</span>}
      {remove.error && (
        <span role="alert">
          {remove.error instanceof ApiError && remove.error.status === 409
            ? " This chore has history, so it can only be archived."
            : " Could not delete."}
        </span>
      )}
    </>
  );
}

function AddChoreForm({ householdId }: { householdId: string }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [days, setDays] = useState("1");
  const create = useMutation({
    mutationFn: () =>
      api(`/households/${householdId}/chores`, {
        method: "POST",
        body: JSON.stringify({ name, schedule: { kind: "fixed", rule: { type: "every_n_days", n: Number(days) } } }),
      }),
    onSuccess: () => {
      setName("");
      return queryClient.invalidateQueries({ queryKey: ["chores", householdId] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <form onSubmit={submit}>
      <label>
        Chore name <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>{" "}
      <label>
        Every N days <input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} required />
      </label>{" "}
      <button type="submit" disabled={create.isPending}>
        Add chore
      </button>
      {create.error && <span role="alert"> Could not add the chore.</span>}
    </form>
  );
}

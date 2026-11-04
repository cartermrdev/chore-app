import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { api, type Chore, type CompleteResult } from "../api";

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
        {chores.data?.chores.map((chore) => <ChoreRow key={chore.id} householdId={householdId} chore={chore} />)}
      </ul>
    </section>
  );
}

function ChoreRow({ householdId, chore }: { householdId: string; chore: Chore }) {
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

  // Early Completion: an explicit request naming the next Occurrence; one key per press, reused on retry.
  const earlyKey = useRef<string | null>(null);
  const completeEarly = useMutation({
    mutationFn: (dueDate: string) => {
      earlyKey.current ??= crypto.randomUUID();
      return api<CompleteResult>(`/households/${householdId}/chores/${chore.id}/complete-early`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: earlyKey.current, dueDate }),
      });
    },
    retry: 2,
    onSettled: () => {
      earlyKey.current = null;
      return queryClient.invalidateQueries({ queryKey: ["chores", householdId] });
    },
  });

  const occ = chore.currentOccurrence;
  const nextDue = chore.nextDue;
  return (
    <li>
      <strong>{chore.name}</strong>{" "}
      {occ ? <span>{STATUS_LABEL[occ.status]}</span> : <span>Not due yet</span>}
      {occ?.completion && (
        <span>
          {" "}
          · Completed {occ.completion.early ? "early " : ""}by {occ.completion.completer.displayName}
          {occ.completion.late ? " (Late)" : ""}
        </span>
      )}
      {nextDue && <span> · Next due {nextDue.dueDate}</span>}{" "}
      {occ?.status === "open" ? (
        <button type="button" disabled={complete.isPending} onClick={() => complete.mutate()}>
          Complete
        </button>
      ) : (
        nextDue && (
          <button
            type="button"
            disabled={completeEarly.isPending}
            onClick={() => completeEarly.mutate(nextDue.dueDate)}
          >
            Complete early
          </button>
        )
      )}
      {(complete.error || completeEarly.error) && <span role="alert"> Could not complete. Try again.</span>}
    </li>
  );
}

type ScheduleKind = "every_n_days" | "interval" | "one_off";

function scheduleFor(kind: ScheduleKind, days: number, dueDate: string) {
  switch (kind) {
    case "every_n_days":
      return { kind: "fixed", rule: { type: "every_n_days", n: days } };
    case "interval":
      return { kind: "interval", periodDays: days };
    case "one_off":
      return { kind: "one_off", dueDate };
  }
}

function AddChoreForm({ householdId }: { householdId: string }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("every_n_days");
  const [days, setDays] = useState("1");
  const [dueDate, setDueDate] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api(`/households/${householdId}/chores`, {
        method: "POST",
        body: JSON.stringify({ name, schedule: scheduleFor(kind, Number(days), dueDate) }),
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
      <select aria-label="Schedule" value={kind} onChange={(e) => setKind(e.target.value as ScheduleKind)}>
        <option value="every_n_days">Every N days</option>
        <option value="interval">Interval</option>
        <option value="one_off">One-off</option>
      </select>{" "}
      {kind !== "one_off" ? (
        <label>
          {kind === "interval" ? "Days after the last completion" : "Every N days"}{" "}
          <input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} required />
        </label>
      ) : (
        <label>
          Due date <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
        </label>
      )}{" "}
      <button type="submit" disabled={create.isPending}>
        Add chore
      </button>
      {create.error && <span role="alert"> Could not add the chore.</span>}
    </form>
  );
}

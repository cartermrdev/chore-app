import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { api, type Chore, type CompleteResult } from "../api";
import {
  describeSchedule,
  draftFromSchedule,
  EMPTY_DRAFT,
  ScheduleFields,
  scheduleFromDraft,
  type ScheduleDraft,
} from "./schedule-fields";

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

  const [editing, setEditing] = useState(false);
  const occ = chore.currentOccurrence;
  return (
    <li>
      <strong>{chore.name}</strong> <span>({describeSchedule(chore.schedule)})</span>{" "}
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
      {isAdmin && !editing && (
        <button type="button" onClick={() => setEditing(true)}>
          Edit
        </button>
      )}
      {editing && <EditChoreForm householdId={householdId} chore={chore} onDone={() => setEditing(false)} />}
    </li>
  );
}

function AddChoreForm({ householdId }: { householdId: string }) {
  const queryClient = useQueryClient();
  const [formKey, setFormKey] = useState(0);
  const create = useMutation({
    mutationFn: (body: ChoreFormValues) =>
      api(`/households/${householdId}/chores`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setFormKey((k) => k + 1); // reset the form
      return queryClient.invalidateQueries({ queryKey: ["chores", householdId] });
    },
  });

  return (
    <ChoreForm
      key={formKey}
      label="Add chore"
      initialName=""
      initialSchedule={EMPTY_DRAFT}
      pending={create.isPending}
      error={create.error ? "Could not add the chore." : null}
      onSubmit={(values) => create.mutate(values)}
    />
  );
}

/**
 * Edits a Chore's name and Schedule. The backend applies a new Schedule only
 * to Occurrences not yet created; the current one keeps its due date and Window.
 */
function EditChoreForm({ householdId, chore, onDone }: { householdId: string; chore: Chore; onDone: () => void }) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (body: ChoreFormValues) =>
      api(`/households/${householdId}/chores/${chore.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["chores", householdId] });
      onDone();
    },
  });

  return (
    <ChoreForm
      label="Edit chore"
      submitText="Save"
      initialName={chore.name}
      initialSchedule={draftFromSchedule(chore.schedule)}
      pending={save.isPending}
      error={save.error ? "Could not save the chore." : null}
      onSubmit={(values) => save.mutate(values)}
      onCancel={onDone}
    />
  );
}

type ChoreFormValues = { name: string; schedule: ReturnType<typeof scheduleFromDraft> };

function ChoreForm(props: {
  label: string;
  submitText?: string;
  initialName: string;
  initialSchedule: ScheduleDraft;
  pending: boolean;
  error: string | null;
  onSubmit: (values: ChoreFormValues) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(props.initialName);
  const [schedule, setSchedule] = useState(props.initialSchedule);
  const [invalid, setInvalid] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (schedule.repeats === "weekdays" && schedule.weekdays.length === 0) {
      setInvalid("Choose at least one weekday.");
      return;
    }
    setInvalid(null);
    props.onSubmit({ name, schedule: scheduleFromDraft(schedule) });
  };

  return (
    <form aria-label={props.label} onSubmit={submit}>
      <label>
        Chore name <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>{" "}
      <ScheduleFields draft={schedule} onChange={setSchedule} />{" "}
      <button type="submit" disabled={props.pending}>
        {props.submitText ?? props.label}
      </button>
      {props.onCancel && (
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      )}
      {(invalid ?? props.error) && <span role="alert"> {invalid ?? props.error}</span>}
    </form>
  );
}

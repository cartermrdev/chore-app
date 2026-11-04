import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { api, type Chore, type CompleteResult, type Member } from "../api";
import {
  AssigneeSelect,
  describeSchedule,
  draftFromSchedule,
  EMPTY_DRAFT,
  ScheduleFields,
  scheduleFromDraft,
  type ScheduleDraft,
} from "./schedule-fields";

const STATUS_LABEL = { open: "Open", completed: "Completed", missed: "Missed", skipped: "Skipped" } as const;

/** The Household's current Persons (for choosing and naming Assignees). */
function useMembers(householdId: string): Member[] {
  const members = useQuery({
    queryKey: ["members", householdId],
    queryFn: () => api<{ members: Member[] }>(`/households/${householdId}/members`),
  });
  return members.data?.members ?? [];
}

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
  const members = useMembers(householdId);
  const nameOf = (id: string) => members.find((m) => m.personId === id)?.displayName;
  const occ = chore.currentOccurrence;
  const hasSlots = chore.schedule.kind === "fixed" && Boolean(chore.schedule.slots?.length);
  // The current Occurrence's Assignee, else (before any Occurrence) the Chore's.
  const assignee = occ ? occ.assignee : hasSlots ? null : chore.assignee;
  return (
    <li>
      <strong>{chore.name}</strong> <span>({describeSchedule(chore.schedule, nameOf)})</span>{" "}
      {occ ? (
        <span>
          {occ.timeSlot ? `${occ.timeSlot}: ` : ""}
          {STATUS_LABEL[occ.status]}
        </span>
      ) : (
        <span>Not due yet</span>
      )}
      {assignee && <span> · Assigned to {assignee.displayName}</span>}
      {occ?.completion && (
        <span>
          {" "}
          · Completed by {occ.completion.completer.displayName} · {occ.completion.late ? "Late" : "On time"}
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
      householdId={householdId}
      label="Add chore"
      initialName=""
      initialAssigneeId=""
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
      householdId={householdId}
      label="Edit chore"
      submitText="Save"
      initialName={chore.name}
      initialAssigneeId={chore.assignee?.id ?? ""}
      initialSchedule={draftFromSchedule(chore.schedule)}
      pending={save.isPending}
      error={save.error ? "Could not save the chore." : null}
      onSubmit={(values) => save.mutate(values)}
      onCancel={onDone}
    />
  );
}

type ChoreFormValues = { name: string; assigneeId: string | null; schedule: ReturnType<typeof scheduleFromDraft> };

function ChoreForm(props: {
  householdId: string;
  label: string;
  submitText?: string;
  initialName: string;
  initialAssigneeId: string;
  initialSchedule: ScheduleDraft;
  pending: boolean;
  error: string | null;
  onSubmit: (values: ChoreFormValues) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(props.initialName);
  const [schedule, setSchedule] = useState(props.initialSchedule);
  const [assigneeId, setAssigneeId] = useState(props.initialAssigneeId);
  const [invalid, setInvalid] = useState<string | null>(null);
  const members = useMembers(props.householdId);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (schedule.repeats === "weekdays" && schedule.weekdays.length === 0) {
      setInvalid("Choose at least one weekday.");
      return;
    }
    setInvalid(null);
    props.onSubmit({ name, assigneeId: assigneeId || null, schedule: scheduleFromDraft(schedule) });
  };

  return (
    <form aria-label={props.label} onSubmit={submit}>
      <label>
        Chore name <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>{" "}
      {/* With Time Slots, each slot has its own Assignee instead. */}
      {schedule.slots.length === 0 && (
        <>
          <AssigneeSelect label="Assignee" value={assigneeId} members={members} onChange={setAssigneeId} />{" "}
        </>
      )}
      <ScheduleFields draft={schedule} members={members} onChange={setSchedule} />{" "}
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

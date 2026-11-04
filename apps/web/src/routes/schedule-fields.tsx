// Editing a Chore's Schedule. The form works on a ScheduleDraft (strings, as
// typed) and converts to the API's Schedule only on submit. To add more to a
// Schedule, add a field to the draft, its inputs to ScheduleFields, and its
// conversion to draftFromSchedule/scheduleFromDraft.
import { useId } from "react";
import type { FixedRule, HouseholdPerson, Schedule, TimeSlot, Weekday } from "../api";

/** A Fixed rule type, or an Interval or One-off Schedule. */
export type Repeats = FixedRule["type"] | "interval" | "one_off";

/** A Time Slot as typed; assigneeId "" means unassigned. */
export type SlotDraft = { name: string; start: string; assigneeId: string };

export type ScheduleDraft = {
  repeats: Repeats;
  everyNDays: string;
  weekdays: Weekday[];
  everyNWeeks: string;
  dayOfMonth: string;
  /** Fixed only. */
  slots: SlotDraft[];
  /** Interval: days after the last Completion. */
  periodDays: string;
  /** One-off: YYYY-MM-DD. */
  dueDate: string;
};

export const WEEKDAYS: { value: Weekday; label: string }[] = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];

export const EMPTY_DRAFT: ScheduleDraft = {
  repeats: "every_n_days",
  everyNDays: "1",
  weekdays: [],
  everyNWeeks: "1",
  dayOfMonth: "1",
  slots: [],
  periodDays: "30",
  dueDate: "",
};

export function draftFromSchedule(schedule: Schedule): ScheduleDraft {
  if (schedule.kind === "interval") return { ...EMPTY_DRAFT, repeats: "interval", periodDays: String(schedule.periodDays) };
  if (schedule.kind === "one_off") return { ...EMPTY_DRAFT, repeats: "one_off", dueDate: schedule.dueDate };
  const slots = (schedule.slots ?? []).map((s) => ({ name: s.name, start: s.start, assigneeId: s.assigneeId ?? "" }));
  const rule = schedule.rule;
  switch (rule.type) {
    case "every_n_days":
      return { ...EMPTY_DRAFT, slots, repeats: rule.type, everyNDays: String(rule.n) };
    case "weekdays":
      return { ...EMPTY_DRAFT, slots, repeats: rule.type, weekdays: rule.weekdays, everyNWeeks: String(rule.n) };
    case "monthly":
      return { ...EMPTY_DRAFT, slots, repeats: rule.type, dayOfMonth: String(rule.day) };
  }
}

/**
 * The request body's `schedule`. startDate is left out, so the backend
 * starts the (new) Schedule today in the Household's time zone. An empty
 * slot list removes any Time Slots.
 */
export function scheduleFromDraft(draft: ScheduleDraft): ScheduleInput {
  const slots = draft.slots.map((s) => ({ name: s.name.trim(), start: s.start, assigneeId: s.assigneeId || null }));
  switch (draft.repeats) {
    case "interval":
      return { kind: "interval", periodDays: Number(draft.periodDays) };
    case "one_off":
      return { kind: "one_off", dueDate: draft.dueDate };
    case "every_n_days":
      return { kind: "fixed", slots, rule: { type: "every_n_days", n: Number(draft.everyNDays) } };
    case "weekdays":
      return { kind: "fixed", slots, rule: { type: "weekdays", weekdays: draft.weekdays, n: Number(draft.everyNWeeks) } };
    case "monthly":
      return { kind: "fixed", slots, rule: { type: "monthly", day: Number(draft.dayOfMonth) } };
  }
}

/** A Schedule as sent to the API (startDate omitted). */
export type ScheduleInput =
  | { kind: "fixed"; rule: FixedRule; slots: TimeSlot[] }
  | { kind: "interval"; periodDays: number }
  | { kind: "one_off"; dueDate: string };

/** E.g. "Every day at Morning 06:00 (Sam), Evening 17:00". `nameOf` names slot Assignees. */
export function describeSchedule(schedule: Schedule, nameOf: (personId: string) => string | undefined = () => undefined): string {
  if (schedule.kind === "one_off") return `Once, on ${schedule.dueDate}`;
  if (schedule.kind === "interval") {
    return schedule.periodDays === 1 ? "A day after each completion" : `${schedule.periodDays} days after each completion`;
  }
  const slots = schedule.slots?.length
    ? " at " +
      schedule.slots
        .map((s) => {
          const who = s.assigneeId ? nameOf(s.assigneeId) : undefined;
          return `${s.name} ${s.start}${who ? ` (${who})` : ""}`;
        })
        .join(", ")
    : "";
  return describeRule(schedule.rule) + slots;
}

function describeRule(rule: FixedRule): string {
  switch (rule.type) {
    case "every_n_days":
      return rule.n === 1 ? "Every day" : `Every ${rule.n} days`;
    case "weekdays": {
      const days = rule.weekdays.map((d) => WEEKDAYS[d - 1]!.label).join(", ");
      return rule.n === 1 ? `Every week on ${days}` : `Every ${rule.n} weeks on ${days}`;
    }
    case "monthly":
      return `Monthly on day ${rule.day}`;
  }
}

/** A select of the Household's Persons, with "(nobody)" for unassigned. */
export function AssigneeSelect(props: { label: string; value: string; persons: HouseholdPerson[]; onChange: (personId: string) => void }) {
  return (
    <select aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      <option value="">(nobody)</option>
      {props.persons.map((m) => (
        <option key={m.id} value={m.id}>
          {m.displayName}
        </option>
      ))}
    </select>
  );
}

/** Time Slot rows: name, start time and Assignee, with add and remove buttons. */
function SlotFields({ slots, persons, onChange }: { slots: SlotDraft[]; persons: HouseholdPerson[]; onChange: (s: SlotDraft[]) => void }) {
  const update = (i: number, patch: Partial<SlotDraft>) => onChange(slots.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <fieldset>
      <legend>Time slots</legend>
      {slots.length === 0 && <span>None: due once per day. </span>}
      {slots.map((slot, i) => (
        <div key={i}>
          <input
            aria-label={`Slot ${i + 1} name`}
            placeholder="Morning"
            value={slot.name}
            onChange={(e) => update(i, { name: e.target.value })}
            required
          />{" "}
          <input
            aria-label={`Slot ${i + 1} start`}
            type="time"
            value={slot.start}
            onChange={(e) => update(i, { start: e.target.value })}
            required
          />{" "}
          <AssigneeSelect
            label={`Slot ${i + 1} assignee`}
            value={slot.assigneeId}
            persons={persons}
            onChange={(assigneeId) => update(i, { assigneeId })}
          />{" "}
          <button type="button" aria-label={`Remove slot ${i + 1}`} onClick={() => onChange(slots.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...slots, { name: "", start: "", assigneeId: "" }])}>
        Add time slot
      </button>
    </fieldset>
  );
}

export function ScheduleFields({
  draft,
  persons,
  onChange,
}: {
  draft: ScheduleDraft;
  persons: HouseholdPerson[];
  onChange: (d: ScheduleDraft) => void;
}) {
  const repeatsId = useId();
  const set = (patch: Partial<ScheduleDraft>) => onChange({ ...draft, ...patch });
  const toggleDay = (day: Weekday, on: boolean) =>
    set({ weekdays: on ? [...draft.weekdays, day].sort((a, b) => a - b) : draft.weekdays.filter((d) => d !== day) });

  return (
    <>
      {/* Not wrapping the select, so its option texts stay out of the label's name. */}
      <label htmlFor={repeatsId}>Repeats</label>{" "}
      <select id={repeatsId} value={draft.repeats} onChange={(e) => set({ repeats: e.target.value as Repeats })}>
          <option value="every_n_days">Every N days</option>
          <option value="weekdays">On weekdays</option>
          <option value="monthly">Monthly</option>
          <option value="interval">Interval</option>
          <option value="one_off">One-off</option>
        </select>{" "}
      {draft.repeats === "interval" && (
        <label>
          Days after the last completion{" "}
          <input
            type="number"
            min={1}
            max={3660}
            value={draft.periodDays}
            onChange={(e) => set({ periodDays: e.target.value })}
            required
          />
        </label>
      )}
      {draft.repeats === "one_off" && (
        <label>
          Due date <input type="date" value={draft.dueDate} onChange={(e) => set({ dueDate: e.target.value })} required />
        </label>
      )}
      {draft.repeats === "every_n_days" && (
        <label>
          Every N days{" "}
          <input
            type="number"
            min={1}
            max={366}
            value={draft.everyNDays}
            onChange={(e) => set({ everyNDays: e.target.value })}
            required
          />
        </label>
      )}
      {draft.repeats === "weekdays" && (
        <>
          <fieldset style={{ display: "inline" }}>
            <legend>Weekdays</legend>
            {WEEKDAYS.map((d) => (
              <label key={d.value}>
                <input
                  type="checkbox"
                  checked={draft.weekdays.includes(d.value)}
                  onChange={(e) => toggleDay(d.value, e.target.checked)}
                />
                {d.label}
              </label>
            ))}
          </fieldset>{" "}
          <label>
            Every N weeks{" "}
            <input
              type="number"
              min={1}
              max={52}
              value={draft.everyNWeeks}
              onChange={(e) => set({ everyNWeeks: e.target.value })}
              required
            />
          </label>
        </>
      )}
      {draft.repeats === "monthly" && (
        <label>
          Day of month{" "}
          <input
            type="number"
            min={1}
            max={31}
            value={draft.dayOfMonth}
            onChange={(e) => set({ dayOfMonth: e.target.value })}
            required
          />
        </label>
      )}
      {/* Time Slots are Fixed-only. */}
      {draft.repeats !== "interval" && draft.repeats !== "one_off" && (
        <SlotFields slots={draft.slots} persons={persons} onChange={(slots) => set({ slots })} />
      )}
    </>
  );
}

// Editing a Chore's Schedule. The form works on a ScheduleDraft (strings, as
// typed) and converts to the API's Schedule only on submit. To add more to a
// Schedule (e.g. Time Slots), add a field to the draft, its inputs to
// ScheduleFields, and its conversion to draftFromSchedule/scheduleFromDraft.
import { useId } from "react";
import type { FixedRule, Schedule, Weekday } from "../api";

export type Repeats = FixedRule["type"];

export type ScheduleDraft = {
  repeats: Repeats;
  everyNDays: string;
  weekdays: Weekday[];
  everyNWeeks: string;
  dayOfMonth: string;
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
};

export function draftFromSchedule(schedule: Schedule): ScheduleDraft {
  if (schedule.kind !== "fixed") return EMPTY_DRAFT;
  const rule = schedule.rule;
  switch (rule.type) {
    case "every_n_days":
      return { ...EMPTY_DRAFT, repeats: rule.type, everyNDays: String(rule.n) };
    case "weekdays":
      return { ...EMPTY_DRAFT, repeats: rule.type, weekdays: rule.weekdays, everyNWeeks: String(rule.n) };
    case "monthly":
      return { ...EMPTY_DRAFT, repeats: rule.type, dayOfMonth: String(rule.day) };
  }
}

/**
 * The request body's `schedule`. startDate is left out, so the backend
 * starts the (new) Schedule today in the Household's time zone.
 */
export function scheduleFromDraft(draft: ScheduleDraft): { kind: "fixed"; rule: FixedRule } {
  switch (draft.repeats) {
    case "every_n_days":
      return { kind: "fixed", rule: { type: "every_n_days", n: Number(draft.everyNDays) } };
    case "weekdays":
      return { kind: "fixed", rule: { type: "weekdays", weekdays: draft.weekdays, n: Number(draft.everyNWeeks) } };
    case "monthly":
      return { kind: "fixed", rule: { type: "monthly", day: Number(draft.dayOfMonth) } };
  }
}

export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === "one_off") return `Once, on ${schedule.dueDate}`;
  const rule = schedule.rule;
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

export function ScheduleFields({ draft, onChange }: { draft: ScheduleDraft; onChange: (d: ScheduleDraft) => void }) {
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
        </select>{" "}
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
    </>
  );
}

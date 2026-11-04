import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type AssignedOutcome, type HistoryCompletion, type HistoryPerson, type HouseholdHistory, type PersonHistory, type PersonRef } from "../api";

const OUTCOME_LABEL: Record<AssignedOutcome, string> = {
  on_time: "Completed on time",
  late: "Completed Late",
  by_someone_else: "Completed by someone else",
  missed: "Missed",
  skipped: "Skipped",
};

/**
 * The accountability views, visible to everyone in the Household: the
 * Household history (every Completion) and one Person's history, over a
 * shared date range (blank = the last 7 days).
 */
export function HistoryViews({ householdId }: { householdId: string }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const query = new URLSearchParams();
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  const qs = query.toString() ? `?${query}` : "";

  const household = useQuery({
    queryKey: ["history", householdId, from, to],
    queryFn: () => api<HouseholdHistory>(`/households/${householdId}/history${qs}`),
  });

  return (
    <>
      <fieldset>
        <legend>History range</legend>
        <label>
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>{" "}
        <label>
          To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {household.data && (
          <span>
            {" "}
            Showing {household.data.from} to {household.data.to}
          </span>
        )}
      </fieldset>
      <section aria-label="Household history">
        <h2>Household history</h2>
        {household.isError && <p role="alert">Could not load history. Check the dates.</p>}
        {household.data && household.data.completions.length === 0 && <p>No completions.</p>}
        {household.data && household.data.completions.length > 0 && <CompletionTable completions={household.data.completions} />}
      </section>
      <PersonHistoryView householdId={householdId} qs={qs} rangeKey={[from, to]} />
    </>
  );
}

function PersonHistoryView({
  householdId,
  qs,
  rangeKey,
}: {
  householdId: string;
  qs: string;
  rangeKey: string[];
}) {
  const [personId, setPersonId] = useState("");
  // Everyone who ever had a Membership here, so an ended one can be chosen even with nothing in range.
  const persons = useQuery({
    queryKey: ["history", householdId, "persons"],
    queryFn: () => api<{ persons: HistoryPerson[] }>(`/households/${householdId}/history/persons`),
  });

  const history = useQuery({
    queryKey: ["history", householdId, "person", personId, ...rangeKey],
    queryFn: () => api<PersonHistory>(`/households/${householdId}/history/persons/${personId}${qs}`),
    enabled: personId !== "",
  });

  return (
    <section aria-label="Person history">
      <h2>Person history</h2>
      <label>
        Person{" "}
        <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
          <option value="">Choose…</option>
          {persons.data?.persons.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
              {p.current ? "" : " (left)"}
            </option>
          ))}
        </select>
      </label>
      {history.isError && <p role="alert">Could not load history.</p>}
      {history.data && (
        <>
          <h3>Assigned to {history.data.person.displayName}</h3>
          {history.data.assigned.length === 0 ? (
            <p>Nothing assigned in this range.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Due</th>
                  <th>Chore</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {history.data.assigned.map((a) => (
                  <tr key={a.occurrenceId}>
                    <td>
                      {a.dueDate}
                      {a.timeSlot && ` ${a.timeSlot}`}
                    </td>
                    <td>{a.chore.name}</td>
                    <td>
                      {OUTCOME_LABEL[a.outcome]}
                      {a.outcome === "by_someone_else" && a.completion && ` (${a.completion.completer.displayName})`}
                      {a.completion && a.outcome !== "by_someone_else" && ` at ${time(a.completion.completedAt)}`}
                      {a.skip?.reason === "excused" && ` · Excused by ${a.skip.excusedBy.displayName}: ${a.skip.note}`}
                      {a.skip?.reason === "pause" && ` · ${a.skip.pause.choreId ? "Chore" : "Household"} paused`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <section aria-label="Other completions">
            <h3>Other completions by {history.data.person.displayName}</h3>
            {history.data.otherCompletions.length === 0 ? (
              <p>None.</p>
            ) : (
              <CompletionTable completions={history.data.otherCompletions} />
            )}
          </section>
        </>
      )}
    </section>
  );
}

function CompletionTable({ completions }: { completions: HistoryCompletion[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>When</th>
          <th>Chore</th>
          <th>Completer</th>
          <th>Method</th>
          <th>Timing</th>
        </tr>
      </thead>
      <tbody>
        {completions.map((c) => (
          <tr key={c.id} style={c.voided ? { textDecoration: "line-through" } : undefined}>
            <td>{time(c.completedAt)}</td>
            <td>
              {c.chore.name}
              {c.occurrence.timeSlot && ` (${c.occurrence.timeSlot})`}
              {c.occurrence.assignee && ` · Assigned to ${c.occurrence.assignee.displayName}`}
            </td>
            <td>
              {c.completer.displayName}
              {differs(c.recorder, c.completer) && ` (recorded by ${c.recorder.displayName})`}
            </td>
            <td>{c.method === "nfc" ? `NFC · Tag ${c.tagId}` : "Manual"}</td>
            <td>
              {c.early ? "Early" : c.late ? "Late" : "On time"}
              {c.voided && ` · Voided by ${c.voided.by.displayName}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function differs(a: PersonRef, b: PersonRef) {
  return a.id !== b.id;
}

function time(iso: string) {
  return new Date(iso).toLocaleString();
}

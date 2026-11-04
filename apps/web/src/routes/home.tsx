import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, ApiError, type Me } from "../api";
import { ChoreList } from "./chores";

export function HomePage() {
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("/me"),
    retry: false,
  });

  if (me.isPending) return <p>Loading…</p>;
  if (me.error instanceof ApiError && me.error.status === 401) return <p>You are not signed in.</p>;
  if (me.error) return <p role="alert">Something went wrong.</p>;

  return (
    <>
      <p>Signed in as {me.data.person.displayName}</p>
      {me.data.memberships.map((m) => (
        <article key={m.household.id}>
          <h1>{m.household.name}</h1>
          <p>Time zone: {m.household.timeZone}</p>
          {m.role === "admin" && <HouseholdSettings householdId={m.household.id} timeZone={m.household.timeZone} />}
          <ChoreList householdId={m.household.id} isAdmin={m.role === "admin"} />
        </article>
      ))}
    </>
  );
}

/** Admin-only: the Household's time zone (an IANA name such as Europe/London). */
function HouseholdSettings({ householdId, timeZone }: { householdId: string; timeZone: string }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(timeZone);
  const save = useMutation({
    mutationFn: () =>
      api(`/households/${householdId}`, { method: "PATCH", body: JSON.stringify({ timeZone: value.trim() }) }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["me"] }),
        queryClient.invalidateQueries({ queryKey: ["chores", householdId] }),
      ]),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form aria-label="Household settings" onSubmit={submit}>
      <label>
        Time zone <input value={value} onChange={(e) => setValue(e.target.value)} required />
      </label>{" "}
      <button type="submit" disabled={save.isPending}>
        Save time zone
      </button>
      {save.error && <span role="alert"> That isn't a known time zone.</span>}
    </form>
  );
}

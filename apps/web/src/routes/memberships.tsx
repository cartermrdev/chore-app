import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError, type HouseholdPerson, type Me } from "../api";
import { useHouseholdPersons } from "./corrections";

type Role = HouseholdPerson["role"];
type Membership = Me["memberships"][number];

const STORAGE_KEY = "chore-app:household";

function remembered(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * The Household shown on the home page. A Person with several Memberships
 * switches between them; the choice is remembered on this device. Scans never
 * use this: a Scan's Household always comes from the Tag (ADR 0002).
 */
export function useCurrentHousehold(memberships: Membership[]) {
  const [chosen, setChosen] = useState<string | null>(remembered);
  const current = memberships.find((m) => m.household.id === chosen) ?? memberships[0];
  const choose = (id: string) => {
    setChosen(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Storage unavailable: the choice lasts until reload.
    }
  };
  return { current, choose };
}

/** Shown only to Persons with more than one Household. */
export function HouseholdSwitcher({
  memberships,
  currentId,
  onChoose,
}: {
  memberships: Membership[];
  currentId: string | undefined;
  onChoose: (id: string) => void;
}) {
  if (memberships.length < 2) return null;
  return (
    <nav aria-label="Households">
      {memberships.map((m) => (
        <button
          key={m.household.id}
          type="button"
          aria-pressed={m.household.id === currentId}
          onClick={() => onChoose(m.household.id)}
        >
          {m.household.name}
        </button>
      ))}
    </nav>
  );
}

const errorText = (e: unknown) =>
  e instanceof ApiError && (e.body as { error?: string } | null)?.error === "last_admin"
    ? "A Household needs at least one Admin."
    : "That didn't work. Try again.";

/** Admin only: the Household's Memberships, with Role changes and ending a Membership. */
export function MembershipManager({ householdId, myId }: { householdId: string; myId: string }) {
  const queryClient = useQueryClient();
  const persons = useHouseholdPersons(householdId, true);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["persons", householdId] }),
      queryClient.invalidateQueries({ queryKey: ["me"] }),
    ]);
  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) =>
      api(`/households/${householdId}/persons/${id}`, { method: "PATCH", body: JSON.stringify({ role }) }),
    onSettled: refresh,
  });
  const end = useMutation({
    mutationFn: (id: string) => api(`/households/${householdId}/persons/${id}`, { method: "DELETE" }),
    onSettled: refresh,
  });
  const error = setRole.error ?? end.error;

  return (
    <section aria-label="People">
      <h2>People</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {persons.data?.persons.map((p) => (
            <tr key={p.id}>
              <td>{p.displayName}</td>
              <td>
                <select
                  aria-label={`Role for ${p.displayName}`}
                  value={p.role}
                  disabled={setRole.isPending}
                  onChange={(e) => {
                    end.reset();
                    setRole.mutate({ id: p.id, role: e.target.value as Role });
                  }}
                >
                  <option value="admin">Admin</option>
                  <option value="standard">Standard</option>
                </select>
              </td>
              <td>
                <button
                  type="button"
                  aria-label={p.id === myId ? "Leave this Household" : `End ${p.displayName}'s membership`}
                  disabled={end.isPending}
                  onClick={() => {
                    setRole.reset();
                    end.mutate(p.id);
                  }}
                >
                  {p.id === myId ? "Leave" : "End membership"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p role="alert">{errorText(error)}</p>}
    </section>
  );
}

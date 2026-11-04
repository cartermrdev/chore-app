import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { api, ApiError, type Me } from "../api";
import { signOut } from "../auth";
import { ChoreList } from "./chores";
import { InviteForm } from "./invites";
import { HouseholdSwitcher, MembershipManager, useCurrentHousehold } from "./memberships";
import { TagManager } from "./tags";
import { PauseManager } from "./pauses";

export function HomePage() {
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("/me"),
    retry: false,
  });
  const out = useMutation({ mutationFn: signOut, onSuccess: () => window.location.assign("/") });

  if (me.isPending) return <p>Loading…</p>;
  if (me.error instanceof ApiError && me.error.status === 401) {
    return (
      <>
        <p>You are not signed in.</p>
        <Link to="/sign-in" search={{ next: undefined }}>
          Sign in
        </Link>
      </>
    );
  }
  if (me.error) return <p role="alert">Something went wrong.</p>;

  return (
    <>
      <p>
        Signed in as {me.data.person.displayName}{" "}
        <button type="button" onClick={() => out.mutate()}>
          Sign out
        </button>
      </p>
      <EmailSetting email={me.data.person.email} />
      <Households me={me.data} />
    </>
  );
}

/** One Household at a time; a Person with several switches between them. */
function Households({ me }: { me: Me }) {
  const { current: m, choose } = useCurrentHousehold(me.memberships);
  if (!m) return <p>You aren't in any Household.</p>;
  return (
    <>
      <HouseholdSwitcher memberships={me.memberships} currentId={m.household.id} onChoose={choose} />
      <article key={m.household.id}>
        <h1>{m.household.name}</h1>
        <p>Time zone: {m.household.timeZone}</p>
        {m.role === "admin" && <HouseholdSettings householdId={m.household.id} timeZone={m.household.timeZone} />}
        <ChoreList householdId={m.household.id} isAdmin={m.role === "admin"} />
        <PauseManager householdId={m.household.id} isAdmin={m.role === "admin"} />
        {m.role === "admin" && <TagManager householdId={m.household.id} />}
        {m.role === "admin" && <MembershipManager householdId={m.household.id} myId={me.person.id} />}
        {m.role === "admin" && <InviteForm householdId={m.household.id} />}
      </article>
    </>
  );
}

/** Optional email address, so the Person can sign in with a magic link. */
function EmailSetting({ email }: { email: string | null }) {
  const [value, setValue] = useState(email ?? "");
  const save = useMutation({
    mutationFn: () => api("/me", { method: "PATCH", body: JSON.stringify({ email: value.trim() || null }) }),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label>
        Email for sign-in links (optional){" "}
        <input type="email" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>{" "}
      <button type="submit" disabled={save.isPending}>
        Save email
      </button>
      {save.isSuccess && <span> Saved.</span>}
      {save.error instanceof ApiError && save.error.status === 409 && (
        <span role="alert"> Someone else already uses that address.</span>
      )}
      {save.isError && !(save.error instanceof ApiError && save.error.status === 409) && (
        <span role="alert"> Could not save.</span>
      )}
    </form>
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

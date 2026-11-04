import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, ApiError, type Me } from "../api";
import { signOut } from "../auth";
import { ChoreList } from "./chores";
import { InviteForm } from "./invites";
import { TagManager } from "./tags";

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
      {me.data.memberships.map((m) => (
        <article key={m.household.id}>
          <h1>{m.household.name}</h1>
          <ChoreList householdId={m.household.id} isAdmin={m.role === "admin"} />
          {m.role === "admin" && <TagManager householdId={m.household.id} />}
          {m.role === "admin" && <InviteForm householdId={m.household.id} />}
        </article>
      ))}
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

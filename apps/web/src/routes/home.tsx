import { useQuery } from "@tanstack/react-query";
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
          <ChoreList householdId={m.household.id} isAdmin={m.role === "admin"} />
        </article>
      ))}
    </>
  );
}

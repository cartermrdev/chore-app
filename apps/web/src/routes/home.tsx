import { useQuery } from "@tanstack/react-query";
import { api, ApiError, type Me } from "../api";

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
      {me.data.memberships.map((m) => (
        <h1 key={m.household.id}>{m.household.name}</h1>
      ))}
      <p>Signed in as {me.data.person.displayName}</p>
    </>
  );
}

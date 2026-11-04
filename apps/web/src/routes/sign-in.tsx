import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Me } from "../api";
import { acceptInvite, redeemMagicLink, requestMagicLink, signInWithPasskey } from "../auth";

/** After signing in, load `next` afresh so every query (and a pending Scan) starts with the new session. */
const continueTo = (next: string) => window.location.assign(next);

/**
 * /sign-in?next=…  Passkey first; a magic link for Persons with an email
 * address. A logged-out Scan lands here and returns to /nfc/{tagId} after.
 */
export function SignInPage({ next }: { next: string }) {
  const passkey = useMutation({ mutationFn: signInWithPasskey, onSuccess: () => continueTo(next) });
  const [email, setEmail] = useState("");
  const magic = useMutation({ mutationFn: () => requestMagicLink(email, next) });

  return (
    <section>
      <h1>Sign in</h1>
      <button type="button" disabled={passkey.isPending} onClick={() => passkey.mutate()}>
        Sign in with a passkey
      </button>
      {passkey.isError && <p role="alert">That didn't work. Try again, or use an email link.</p>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          magic.mutate();
        }}
      >
        <label>
          Email <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>{" "}
        <button type="submit" disabled={magic.isPending}>
          Email me a sign-in link
        </button>
      </form>
      {magic.isSuccess && <p>If that address belongs to someone here, we've sent a link: check your email.</p>}
      <p>No passkey and no email? Ask an Admin for a new invite.</p>
    </section>
  );
}

/** /sign-in/magic?token=…&next=…  Redeems the emailed link (by POST, so mail scanners' GETs can't use it). */
export function MagicLinkPage({ token, next }: { token: string; next: string }) {
  const redeem = useMutation({ mutationFn: () => redeemMagicLink(token), onSuccess: () => continueTo(next) });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    redeem.mutate();
  }, [redeem]);

  if (redeem.isError) {
    return (
      <section>
        <h1>This link has expired</h1>
        <p>Sign-in links work once, for 15 minutes.</p>
        <a href={`/sign-in?next=${encodeURIComponent(next)}`}>Get a new one</a>
      </section>
    );
  }
  return <h1>Signing in…</h1>;
}

type InviteInfo = { kind: "new" | "recovery"; displayName: string; household: { name: string } };

/** /invite/{token}  Opened on the invited Person's device: enrols a passkey and signs them in. */
export function InvitePage({ token }: { token: string }) {
  const info = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api<InviteInfo>(`/invites/${encodeURIComponent(token)}`),
    retry: false,
  });
  const accept = useMutation({ mutationFn: () => acceptInvite(token), onSuccess: () => continueTo("/") });
  // Already signed in? Join with this login instead of creating a new Person (ADR 0002).
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/me"), retry: false });
  const join = useMutation({
    mutationFn: () => api(`/invites/${encodeURIComponent(token)}/join`, { method: "POST" }),
    onSuccess: () => continueTo("/"),
  });

  if (info.isPending || me.isPending) return <p>Loading…</p>;
  if (info.error instanceof ApiError && info.error.status === 404) {
    return (
      <section>
        <h1>This invite can't be used</h1>
        <p>It has already been used or has expired. Ask an Admin for a new one.</p>
      </section>
    );
  }
  if (info.error) return <p role="alert">Something went wrong.</p>;

  if (me.data && info.data.kind === "new") {
    const alreadyMember = join.error instanceof ApiError && join.error.status === 409;
    return (
      <section>
        <h1>Join {info.data.household.name}</h1>
        <p>You're signed in as {me.data.person.displayName}. Join with this login to switch between your Households.</p>
        <button type="button" disabled={join.isPending} onClick={() => join.mutate()}>
          Join as {me.data.person.displayName}
        </button>
        {alreadyMember && <p role="alert">You're already in this Household.</p>}
        {join.isError && !alreadyMember && <p role="alert">That didn't work. Try again.</p>}
        <p>
          Not {me.data.person.displayName}?{" "}
          <button type="button" disabled={accept.isPending} onClick={() => accept.mutate()}>
            Set up a passkey for {info.data.displayName}
          </button>
        </p>
        {accept.isError && <p role="alert">That didn't work. Try again.</p>}
      </section>
    );
  }

  return (
    <section>
      <h1>Join {info.data.household.name}</h1>
      <p>
        {info.data.kind === "recovery" ? "Welcome back" : "Welcome"}, {info.data.displayName}. Set up a passkey on this
        device to sign in with Face ID or your screen lock.
      </p>
      <button type="button" disabled={accept.isPending} onClick={() => accept.mutate()}>
        Set up a passkey
      </button>
      {accept.isError && <p role="alert">That didn't work. Try again.</p>}
    </section>
  );
}

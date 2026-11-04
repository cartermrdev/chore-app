// Browser side of sign-in: passkey ceremonies (via @simplewebauthn/browser),
// Invites and magic links. Each ceremony is options -> navigator.credentials -> verify.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api } from "./api";

type Ceremony = { challengeId: string; options: any };

const post = <T,>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? "{}" : JSON.stringify(body) });

/** Signs in with any passkey on this device (Face ID etc.). Throws if cancelled or refused. */
export async function signInWithPasskey(): Promise<void> {
  const { challengeId, options } = await post<Ceremony>("/auth/passkey/options");
  const response = await startAuthentication({ optionsJSON: options });
  await post("/auth/passkey/verify", { challengeId, response });
}

/** Enrols a passkey on this device through an Invite, which also signs in. */
export async function acceptInvite(token: string): Promise<void> {
  const { challengeId, options } = await post<Ceremony>(`/invites/${encodeURIComponent(token)}/options`);
  const response = await startRegistration({ optionsJSON: options });
  await post(`/invites/${encodeURIComponent(token)}/accept`, { challengeId, response });
}

export const requestMagicLink = (email: string, next: string | null) => post("/auth/magic-link", { email, next });

export const redeemMagicLink = (token: string) => post("/auth/magic-link/redeem", { token });

export const signOut = () => post("/auth/sign-out");

/** A path inside this app to go to after signing in; anything else becomes "/". */
export function safeNext(raw: unknown): string {
  return typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\") ? raw : "/";
}

/** The sign-in page for coming back to `path` afterwards (e.g. a Scan). */
export const signInHref = (path: string) => `/sign-in?next=${encodeURIComponent(path)}`;

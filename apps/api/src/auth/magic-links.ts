/**
 * Magic links: the sign-in fallback for Persons who have an email address.
 * The emailed link opens the frontend page /sign-in/magic?token=…[&next=…],
 * which redeems the token with a POST (so a mail scanner's GET can't use it).
 */
import { durationMs } from "../clock";
import { publicOrigin } from "../config";
import type { Deps } from "../app";
import { hashToken, newToken } from "./tokens";

export const MAGIC_LINK_LIFETIME = { minutes: 15 };

/** Lowercased and trimmed, or null if it doesn't look like an email address. */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

/** A path inside the app to continue to after signing in, or null (rejects other origins and "//host"). */
export function safeNext(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  return raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\") ? raw : null;
}

/** Emails a sign-in link if a Person has this address. Says nothing either way. */
export async function requestMagicLink(deps: Deps, input: { email: unknown; next?: unknown }): Promise<void> {
  const email = normaliseEmail(input.email);
  if (!email) return;
  const { db, clock, config, mailer } = deps;
  const [person] = await db`SELECT id FROM persons WHERE email = ${email}`;
  if (!person) return;

  const token = newToken();
  const now = clock.now();
  await db`
    INSERT INTO magic_links (token_hash, person_id, created_at, expires_at)
    VALUES (${hashToken(token)}, ${person.id}, ${now}, ${new Date(now.getTime() + durationMs(MAGIC_LINK_LIFETIME))})`;

  const link = new URL("/sign-in/magic", publicOrigin(config));
  link.searchParams.set("token", token);
  const next = safeNext(input.next);
  if (next) link.searchParams.set("next", next);
  await mailer.send({
    to: email,
    subject: "Sign in to Chores",
    text: `Open this link to sign in. It works once, for 15 minutes.\n\n${link}\n\nIf you didn't ask for it, ignore this email.`,
  });
}

/** Uses the link (once, before it expires). Returns the Person to sign in, or null. */
export async function redeemMagicLink({ db, clock }: Pick<Deps, "db" | "clock">, token: unknown): Promise<string | null> {
  if (typeof token !== "string" || !token) return null;
  const now = clock.now();
  const [row] = await db`
    UPDATE magic_links SET used_at = ${now}
    WHERE token_hash = ${hashToken(token)} AND used_at IS NULL AND expires_at > ${now}
    RETURNING person_id`;
  return row?.person_id ?? null;
}

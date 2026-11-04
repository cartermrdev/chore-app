/**
 * Passkey storage and the server half of the WebAuthn ceremonies. A ceremony
 * is two requests: `begin*` stores a single-use challenge and returns
 * `{ challengeId, options }` for the browser; the second request sends back
 * `{ challengeId, response }`, which is checked against the stored challenge.
 */
import { durationMs } from "../clock";
import type { Deps } from "../app";
import type { Db } from "../db/client";
import type { NewPasskey, StoredPasskey } from "./webauthn";

export const CHALLENGE_LIFETIME = { minutes: 5 };

type Purpose = "invite" | "register" | "sign_in";

export type Ceremony = { challengeId: string; options: { challenge: string } };

export async function storeChallenge(
  { db, clock }: Pick<Deps, "db" | "clock">,
  options: { challenge: string },
  scope: { purpose: Purpose; inviteId?: string; personId?: string },
): Promise<Ceremony> {
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + durationMs(CHALLENGE_LIFETIME));
  const [row] = await db`
    INSERT INTO webauthn_challenges (challenge, purpose, invite_id, person_id, created_at, expires_at)
    VALUES (${options.challenge}, ${scope.purpose}, ${scope.inviteId ?? null}, ${scope.personId ?? null}, ${now}, ${expiresAt})
    RETURNING id`;
  return { challengeId: row.id, options };
}

/** Consumes the challenge (it can be answered once). Null if unknown, expired or for another purpose. */
export async function takeChallenge(
  { db, clock }: Pick<Deps, "db" | "clock">,
  challengeId: unknown,
  purpose: Purpose,
): Promise<{ challenge: string; inviteId: string | null; personId: string | null } | null> {
  if (typeof challengeId !== "string") return null;
  const rows = await db`
    DELETE FROM webauthn_challenges
    WHERE id = ${challengeId}::uuid AND purpose = ${purpose}
    RETURNING challenge, invite_id, person_id, expires_at`.catch(() => []);
  const row = rows[0];
  if (!row || row.expires_at <= clock.now()) return null;
  return { challenge: row.challenge, inviteId: row.invite_id, personId: row.person_id };
}

export async function savePasskey(db: Db, personId: string, passkey: NewPasskey, now: Date): Promise<void> {
  await db`
    INSERT INTO passkeys (credential_id, person_id, public_key, counter, transports, created_at)
    VALUES (${passkey.credentialId}, ${personId}, ${passkey.publicKey}, ${passkey.counter},
            ${passkey.transports}, ${now})`;
}

export async function personPasskeyIds(db: Db, personId: string): Promise<string[]> {
  const rows = await db`SELECT credential_id FROM passkeys WHERE person_id = ${personId}`;
  return rows.map((r: { credential_id: string }) => r.credential_id);
}

async function findPasskey(db: Db, credentialId: string): Promise<StoredPasskey | null> {
  const [row] = await db`
    SELECT credential_id, person_id, public_key, counter, transports FROM passkeys
    WHERE credential_id = ${credentialId}`;
  if (!row) return null;
  return {
    credentialId: row.credential_id,
    personId: row.person_id,
    publicKey: new Uint8Array(row.public_key),
    counter: Number(row.counter),
    transports: row.transports,
  };
}

/** Starts a passkey sign-in: any passkey of any Person may answer (discoverable credentials). */
export async function beginSignIn(deps: Deps): Promise<Ceremony> {
  return storeChallenge(deps, await deps.webauthn.authenticationOptions(), { purpose: "sign_in" });
}

/** Verifies a sign-in assertion. Returns the Person it belongs to, or null. */
export async function finishSignIn(deps: Deps, input: { challengeId: unknown; response: unknown }): Promise<string | null> {
  const challenge = await takeChallenge(deps, input.challengeId, "sign_in");
  if (!challenge) return null;
  const credentialId = (input.response as { id?: unknown } | null)?.id;
  if (typeof credentialId !== "string") return null;
  const passkey = await findPasskey(deps.db, credentialId);
  if (!passkey) return null;
  const verified = await deps.webauthn.verifyAuthentication({
    response: input.response,
    expectedChallenge: challenge.challenge,
    passkey,
  });
  if (!verified) return null;
  await deps.db`
    UPDATE passkeys SET counter = ${verified.counter}, last_used_at = ${deps.clock.now()}
    WHERE credential_id = ${credentialId}`;
  return passkey.personId;
}

/** Starts registering an additional passkey for a signed-in Person. */
export async function beginRegistration(deps: Deps, person: { id: string; displayName: string }): Promise<Ceremony> {
  const options = await deps.webauthn.registrationOptions({
    userHandle: person.id,
    person,
    excludeCredentialIds: await personPasskeyIds(deps.db, person.id),
  });
  return storeChallenge(deps, options, { purpose: "register", personId: person.id });
}

export async function finishRegistration(
  deps: Deps,
  personId: string,
  input: { challengeId: unknown; response: unknown },
): Promise<boolean> {
  const challenge = await takeChallenge(deps, input.challengeId, "register");
  if (!challenge || challenge.personId !== personId) return false;
  const passkey = await deps.webauthn.verifyRegistration({ response: input.response, expectedChallenge: challenge.challenge });
  if (!passkey) return false;
  try {
    await savePasskey(deps.db, personId, passkey, deps.clock.now());
  } catch {
    return false; // credential already registered
  }
  return true;
}

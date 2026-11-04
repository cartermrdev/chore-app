/**
 * Invites: one-time links an Admin issues to enrol a Person's passkey into a
 * Household (GLOSSARY: Invite). Two kinds:
 *  - new:      for a Person who doesn't exist yet, known only by display name.
 *              Accepting it creates the Person and a Membership with the Invite's Role.
 *  - recovery: for an existing Person with a current Membership (e.g. a lost
 *              phone and no email). Accepting it enrols another passkey for them.
 * Either way the accepting device is signed in. An Invite works once and expires.
 */
import { durationMs } from "../clock";
import type { Deps } from "../app";
import type { Role } from "../households/membership";
import { savePasskey, storeChallenge, takeChallenge, type Ceremony } from "../auth/passkeys";
import { hashToken, newToken } from "../auth/tokens";

export const INVITE_LIFETIME = { days: 7 };

export type InviteKind = "new" | "recovery";

/** Returned once, to the Admin who created it: the token is not stored and can't be shown again. */
export type CreatedInvite = {
  id: string;
  kind: InviteKind;
  token: string;
  /** Frontend path to open on the Person's device (shown as a link and a QR code). */
  path: string;
  displayName: string;
  role: Role | null;
  personId: string | null;
  expiresAt: string;
};

export type CreateInviteInput =
  | { householdId: string; createdBy: string; kind: "new"; displayName: string; role: Role }
  | { householdId: string; createdBy: string; kind: "recovery"; personId: string };

export const invitePath = (token: string) => `/invite/${token}`;

export async function createInvite(
  { db, clock }: Pick<Deps, "db" | "clock">,
  input: CreateInviteInput,
): Promise<CreatedInvite | { error: "person_not_found" }> {
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + durationMs(INVITE_LIFETIME));
  const token = newToken();

  let displayName: string;
  if (input.kind === "recovery") {
    const [member] = await db`
      SELECT p.display_name FROM memberships m JOIN persons p ON p.id = m.person_id
      WHERE m.household_id = ${input.householdId} AND m.person_id = ${input.personId}::uuid
        AND m.ended_at IS NULL`.catch(() => []);
    if (!member) return { error: "person_not_found" };
    displayName = member.display_name;
  } else {
    displayName = input.displayName;
  }

  const role = input.kind === "new" ? input.role : null;
  const personId = input.kind === "recovery" ? input.personId : null;
  const [row] = await db`
    INSERT INTO invites (token_hash, household_id, kind, display_name, role, person_id, created_by, created_at, expires_at)
    VALUES (${hashToken(token)}, ${input.householdId}, ${input.kind}, ${input.kind === "new" ? displayName : null},
            ${role}, ${personId}, ${input.createdBy}, ${now}, ${expiresAt})
    RETURNING id`;
  return {
    id: row.id,
    kind: input.kind,
    token,
    path: invitePath(token),
    displayName,
    role,
    personId,
    expiresAt: expiresAt.toISOString(),
  };
}

type OpenInvite = {
  id: string;
  kind: InviteKind;
  householdId: string;
  householdName: string;
  displayName: string;
  role: Role | null;
  personId: string | null;
};

/** The Invite behind `token` if it is unused, unexpired and (for recovery) its Person is still a member. */
export async function findOpenInvite({ db, clock }: Pick<Deps, "db" | "clock">, token: string): Promise<OpenInvite | null> {
  const [row] = await db`
    SELECT i.id, i.kind, i.household_id, h.name AS household_name, i.role, i.person_id,
           COALESCE(i.display_name, p.display_name) AS display_name
    FROM invites i
    JOIN households h ON h.id = i.household_id
    LEFT JOIN persons p ON p.id = i.person_id
    WHERE i.token_hash = ${hashToken(token)} AND i.accepted_at IS NULL AND i.expires_at > ${clock.now()}
      AND (i.kind = 'new' OR EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.household_id = i.household_id AND m.person_id = i.person_id AND m.ended_at IS NULL))`;
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    householdId: row.household_id,
    householdName: row.household_name,
    displayName: row.display_name,
    role: row.role,
    personId: row.person_id,
  };
}

/** What the Invite page shows before enrolling. */
export async function describeInvite(deps: Pick<Deps, "db" | "clock">, token: string) {
  const invite = await findOpenInvite(deps, token);
  if (!invite) return null;
  return { kind: invite.kind, displayName: invite.displayName, household: { name: invite.householdName } };
}

export async function beginInvite(deps: Deps, token: string): Promise<Ceremony | null> {
  const invite = await findOpenInvite(deps, token);
  if (!invite) return null;
  const excludeCredentialIds = invite.personId
    ? (await deps.db`SELECT credential_id FROM passkeys WHERE person_id = ${invite.personId}`).map(
        (r: { credential_id: string }) => r.credential_id,
      )
    : [];
  const options = await deps.webauthn.registrationOptions({
    userHandle: invite.personId ?? invite.id,
    person: { displayName: invite.displayName },
    excludeCredentialIds,
  });
  return storeChallenge(deps, options, { purpose: "invite", inviteId: invite.id });
}

export type AcceptResult = { ok: true; personId: string } | { ok: false; error: "invite_invalid" | "passkey_invalid" };

/**
 * Verifies the new passkey and uses the Invite, atomically: of two concurrent
 * acceptances only one succeeds. Creates the Person and Membership for a new Invite.
 */
export async function acceptInvite(
  deps: Deps,
  token: string,
  input: { challengeId: unknown; response: unknown },
): Promise<AcceptResult> {
  const invite = await findOpenInvite(deps, token);
  if (!invite) return { ok: false, error: "invite_invalid" };
  const challenge = await takeChallenge(deps, input.challengeId, "invite");
  if (!challenge || challenge.inviteId !== invite.id) return { ok: false, error: "passkey_invalid" };
  const passkey = await deps.webauthn.verifyRegistration({ response: input.response, expectedChallenge: challenge.challenge });
  if (!passkey) return { ok: false, error: "passkey_invalid" };

  const now = deps.clock.now();
  try {
    return await deps.db.begin(async (tx) => {
      const used = await tx`
        UPDATE invites SET accepted_at = ${now}
        WHERE id = ${invite.id} AND accepted_at IS NULL AND expires_at > ${now}
        RETURNING id`;
      if (used.length === 0) throw new InviteGone();

      let personId = invite.personId;
      if (!personId) {
        const [person] = await tx`
          INSERT INTO persons (display_name, created_at) VALUES (${invite.displayName}, ${now}) RETURNING id`;
        personId = person.id as string;
        await tx`
          INSERT INTO memberships (household_id, person_id, role, created_at)
          VALUES (${invite.householdId}, ${personId}, ${invite.role}, ${now})`;
        await tx`UPDATE invites SET person_id = ${personId} WHERE id = ${invite.id}`;
      }
      await savePasskey(tx, personId, passkey, now);
      return { ok: true as const, personId };
    });
  } catch (e) {
    if (e instanceof InviteGone) return { ok: false, error: "invite_invalid" };
    throw e;
  }
}

class InviteGone extends Error {}

export type JoinResult =
  | { ok: true; personId: string; householdId: string }
  | { ok: false; error: "invite_invalid" | "already_a_member" };

/**
 * A signed-in Person uses a `new` Invite to join its Household with their
 * existing login (ADR 0002: one Person, many Households). No passkey ceremony:
 * the session already proves who they are. The Invite's Role applies; its
 * display name is ignored (the Person keeps theirs). Recovery Invites can't be
 * joined. A Person who already has a current Membership there gets
 * already_a_member, and the Invite stays unused.
 */
export async function joinWithInvite(
  deps: Pick<Deps, "db" | "clock">,
  token: string,
  personId: string,
): Promise<JoinResult> {
  const invite = await findOpenInvite(deps, token);
  if (!invite || invite.kind !== "new") return { ok: false, error: "invite_invalid" };
  const now = deps.clock.now();
  try {
    return await deps.db.begin(async (tx) => {
      const member = await tx`
        SELECT 1 FROM memberships
        WHERE household_id = ${invite.householdId} AND person_id = ${personId} AND ended_at IS NULL`;
      if (member.length > 0) return { ok: false as const, error: "already_a_member" as const };
      const used = await tx`
        UPDATE invites SET accepted_at = ${now}, person_id = ${personId}
        WHERE id = ${invite.id} AND accepted_at IS NULL AND expires_at > ${now}
        RETURNING id`;
      if (used.length === 0) throw new InviteGone();
      // The unique index on current Memberships stops a concurrent double join.
      await tx`
        INSERT INTO memberships (household_id, person_id, role, created_at)
        VALUES (${invite.householdId}, ${personId}, ${invite.role}, ${now})`;
      return { ok: true as const, personId, householdId: invite.householdId };
    });
  } catch (e) {
    if (e instanceof InviteGone) return { ok: false, error: "invite_invalid" };
    if ((e as { errno?: string })?.errno === "23505" || String(e).includes("memberships_current_unique")) {
      return { ok: false, error: "already_a_member" };
    }
    throw e;
  }
}

/**
 * The WebAuthn (passkey) ceremony adapter. The app depends only on this
 * interface; production uses @simplewebauthn/server, and API tests inject a
 * stub (apps/api/test/fake-webauthn.ts).
 *
 * Options returned here go to the browser as-is (`navigator.credentials`
 * JSON); `challenge` is what the app stores and later expects back.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

export type NewPasskey = {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
};

export type StoredPasskey = NewPasskey & { personId: string };

export interface WebAuthn {
  registrationOptions(input: {
    /** Stable per Person; for a not-yet-created Person, any unique id (e.g. the Invite's). */
    userHandle: string;
    person: { displayName: string };
    excludeCredentialIds: string[];
  }): Promise<{ challenge: string }>;
  /** Null when the response is invalid or doesn't answer `expectedChallenge`. */
  verifyRegistration(input: { response: unknown; expectedChallenge: string }): Promise<NewPasskey | null>;
  authenticationOptions(): Promise<{ challenge: string }>;
  /** Null when the assertion is invalid. Otherwise the passkey's new signature counter. */
  verifyAuthentication(input: {
    response: unknown;
    expectedChallenge: string;
    passkey: StoredPasskey;
  }): Promise<{ counter: number } | null>;
}

/** Real passkeys for the Relying Party at `origin` (the app's public origin, e.g. https://chores.example). */
export function createWebAuthn({ origin, rpName = "Chores" }: { origin: string; rpName?: string }): WebAuthn {
  const rpID = new URL(origin).hostname;
  return {
    registrationOptions: ({ userHandle, person, excludeCredentialIds }) =>
      generateRegistrationOptions({
        rpName,
        rpID,
        userName: person.displayName,
        userDisplayName: person.displayName,
        userID: new TextEncoder().encode(userHandle),
        excludeCredentials: excludeCredentialIds.map((id) => ({ id })),
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      }),
    async verifyRegistration({ response, expectedChallenge }) {
      try {
        const result = await verifyRegistrationResponse({
          response: response as never,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: false,
        });
        if (!result.verified) return null;
        const { credential } = result.registrationInfo;
        return {
          credentialId: credential.id,
          publicKey: credential.publicKey,
          counter: credential.counter,
          transports: credential.transports ?? [],
        };
      } catch {
        return null;
      }
    },
    authenticationOptions: () => generateAuthenticationOptions({ rpID, userVerification: "preferred" }),
    async verifyAuthentication({ response, expectedChallenge, passkey }) {
      try {
        const result = await verifyAuthenticationResponse({
          response: response as never,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id: passkey.credentialId,
            publicKey: passkey.publicKey as never,
            counter: passkey.counter,
            transports: passkey.transports,
          },
          requireUserVerification: false,
        });
        return result.verified ? { counter: result.authenticationInfo.newCounter } : null;
      } catch {
        return null;
      }
    },
  };
}

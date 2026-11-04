/**
 * Stub passkey ceremonies for API tests (spec #13: "Passkey ceremonies are
 * stubbed at the API seam"). The app is given `fakeWebAuthn` in place of the
 * real WebAuthn adapter, and tests use a `FakeDevice` to play the browser and
 * authenticator. The fake still checks the challenge and the key, so
 * replayed, mismatched or unknown credentials fail just as they would for
 * real.
 */
import type { WebAuthn } from "../src/auth/webauthn";

type FakeRegistration = { id: string; type: "fake"; challenge: string; secret: string };
type FakeAssertion = { id: string; type: "fake"; challenge: string; secret: string };

const randomId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");

export const fakeWebAuthn: WebAuthn = {
  async registrationOptions({ person }) {
    return { challenge: randomId(), user: { name: person.displayName } };
  },
  async verifyRegistration({ response, expectedChallenge }) {
    const r = response as Partial<FakeRegistration>;
    if (r?.type !== "fake" || r.challenge !== expectedChallenge || !r.id || !r.secret) return null;
    return { credentialId: r.id, publicKey: new TextEncoder().encode(r.secret), counter: 0, transports: [] };
  },
  async authenticationOptions() {
    return { challenge: randomId() };
  },
  async verifyAuthentication({ response, expectedChallenge, passkey }) {
    const r = response as Partial<FakeAssertion>;
    if (r?.type !== "fake" || r.challenge !== expectedChallenge) return null;
    if (new TextDecoder().decode(passkey.publicKey) !== r.secret) return null;
    return { counter: passkey.counter + 1 };
  },
};

/** A phone holding passkeys. */
export class FakeDevice {
  private credentials: { id: string; secret: string }[] = [];

  /** navigator.credentials.create(): answers registration options with a new credential. */
  create(options: { challenge: string }): FakeRegistration {
    const credential = { id: randomId(), secret: randomId() };
    this.credentials.push(credential);
    return { ...credential, type: "fake", challenge: options.challenge };
  }

  /** navigator.credentials.get(): signs the challenge with the device's latest passkey. */
  get(options: { challenge: string }): FakeAssertion {
    const credential = this.credentials.at(-1);
    if (!credential) throw new Error("FakeDevice has no passkey");
    return { ...credential, type: "fake", challenge: options.challenge };
  }

  get hasPasskey(): boolean {
    return this.credentials.length > 0;
  }
}

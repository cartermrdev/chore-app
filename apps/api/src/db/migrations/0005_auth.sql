-- Passkeys, Invites, magic links and pending WebAuthn challenges (#17).

CREATE TABLE passkeys (
  credential_id  text PRIMARY KEY,           -- base64url, as the browser reports it
  person_id      uuid NOT NULL REFERENCES persons(id),
  public_key     bytea NOT NULL,
  counter        bigint NOT NULL,
  transports     text[] NOT NULL,
  created_at     timestamptz NOT NULL,
  last_used_at   timestamptz
);
CREATE INDEX passkeys_person ON passkeys (person_id);

-- An Invite enrols a Person's passkey into a Household. kind 'new' creates the
-- Person (display_name) and a Membership with `role` on acceptance; kind
-- 'recovery' enrols a passkey for the existing `person_id`. Single use:
-- accepted_at is set exactly once.
CREATE TABLE invites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,
  household_id  uuid NOT NULL REFERENCES households(id),
  kind          text NOT NULL CHECK (kind IN ('new', 'recovery')),
  display_name  text,
  role          text CHECK (role IN ('admin', 'standard')),
  person_id     uuid REFERENCES persons(id),  -- recovery: the Person; new: set on acceptance
  created_by    uuid NOT NULL REFERENCES persons(id),
  created_at    timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  CHECK (kind <> 'new' OR (display_name IS NOT NULL AND role IS NOT NULL)),
  CHECK (kind <> 'recovery' OR person_id IS NOT NULL)
);

CREATE TABLE magic_links (
  token_hash  text PRIMARY KEY,
  person_id   uuid NOT NULL REFERENCES persons(id),
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

-- A challenge handed to the browser and expected back once. purpose 'invite'
-- carries invite_id; 'register' (an extra passkey) carries person_id;
-- 'sign_in' carries neither.
CREATE TABLE webauthn_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge   text NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('invite', 'register', 'sign_in')),
  invite_id   uuid REFERENCES invites(id),
  person_id   uuid REFERENCES persons(id),
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL
);

-- Identity: Households, Persons, Memberships and sessions (ADR 0002).
-- Timestamps come from the app's Clock, so they have no DB defaults.

CREATE TABLE households (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  time_zone   text NOT NULL,
  created_at  timestamptz NOT NULL
);

CREATE TABLE persons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text NOT NULL,
  email         text UNIQUE,
  created_at    timestamptz NOT NULL
);

CREATE TABLE memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  person_id     uuid NOT NULL REFERENCES persons(id),
  role          text NOT NULL CHECK (role IN ('admin', 'standard')),
  created_at    timestamptz NOT NULL,
  ended_at      timestamptz
);

-- At most one current Membership per Person per Household.
CREATE UNIQUE INDEX memberships_current_unique
  ON memberships (household_id, person_id) WHERE ended_at IS NULL;

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  person_id   uuid NOT NULL REFERENCES persons(id),
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL
);

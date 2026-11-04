-- Chores, stored Occurrences (ADR 0003) and Completions.
-- Timestamps come from the app's Clock, so they have no DB defaults.

CREATE TABLE chores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  name          text NOT NULL,
  -- The Schedule engine's structured Schedule (src/schedule/engine.ts), e.g.
  -- {"kind":"fixed","startDate":"2026-03-01","rule":{"type":"every_n_days","n":2}}
  schedule      jsonb NOT NULL,
  created_at    timestamptz NOT NULL,
  archived_at   timestamptz
);

CREATE INDEX chores_household ON chores (household_id);

CREATE TABLE occurrences (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chore_id      uuid NOT NULL REFERENCES chores(id),
  household_id  uuid NOT NULL REFERENCES households(id),
  due_date      date NOT NULL,
  time_slot     text,
  window_start  timestamptz NOT NULL,
  due_time      timestamptz NOT NULL,
  -- Exclusive; null for One-off Occurrences, which are never Missed.
  window_end    timestamptz,
  status        text NOT NULL CHECK (status IN ('open', 'completed', 'missed', 'skipped')),
  created_at    timestamptz NOT NULL
);

-- Materialising twice never duplicates an Occurrence.
CREATE UNIQUE INDEX occurrences_unique
  ON occurrences (chore_id, due_date, (COALESCE(time_slot, '')));

CREATE INDEX occurrences_chore_window ON occurrences (chore_id, window_start);

CREATE TABLE completions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id  uuid NOT NULL REFERENCES occurrences(id),
  household_id   uuid NOT NULL REFERENCES households(id),
  completer_id   uuid NOT NULL REFERENCES persons(id),
  recorder_id    uuid NOT NULL REFERENCES persons(id),
  method         text NOT NULL CHECK (method IN ('manual', 'nfc')),
  -- The Tag scanned, for Method NFC. No FK yet: the tags table arrives with the Tag ticket.
  tag_id         text,
  completed_at   timestamptz NOT NULL,
  late           boolean NOT NULL,
  voided_at      timestamptz,
  voided_by      uuid REFERENCES persons(id),
  CHECK ((method = 'nfc') = (tag_id IS NOT NULL))
);

-- At most one active (non-voided) Completion per Occurrence.
CREATE UNIQUE INDEX completions_one_active_per_occurrence
  ON completions (occurrence_id) WHERE voided_at IS NULL;

-- Idempotency: a repeated completion request (same Recorder, same key) returns
-- the stored original result and creates nothing new.
CREATE TABLE completion_requests (
  recorder_id      uuid NOT NULL REFERENCES persons(id),
  idempotency_key  text NOT NULL,
  result           jsonb,
  created_at       timestamptz NOT NULL,
  PRIMARY KEY (recorder_id, idempotency_key)
);

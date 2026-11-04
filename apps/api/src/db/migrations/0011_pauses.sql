-- Pauses (#24). A Pause belongs to a Chore (chore_id) or to the whole
-- Household (chore_id NULL). It covers start_date through end_date inclusive,
-- in the Household time zone; end_date NULL = indefinite. Pauses are history,
-- never a flag: ending one early sets end_date to the day before it was ended
-- (keeping the original in planned_end_date) and records who ended it.

CREATE TABLE pauses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id     uuid NOT NULL REFERENCES households(id),
  chore_id         uuid REFERENCES chores(id),
  start_date       date NOT NULL,
  end_date         date,
  created_at       timestamptz NOT NULL,
  created_by       uuid NOT NULL REFERENCES persons(id),
  ended_early_at   timestamptz,
  ended_early_by   uuid REFERENCES persons(id),
  planned_end_date date,
  CONSTRAINT pauses_ended_early_complete CHECK ((ended_early_at IS NULL) = (ended_early_by IS NULL)),
  -- An advance Pause ended before it started is left with an empty range (end = start - 1).
  CONSTRAINT pauses_range CHECK (
    end_date IS NULL OR end_date >= start_date OR (ended_early_at IS NOT NULL AND end_date = start_date - 1)
  )
);

CREATE INDEX pauses_household ON pauses (household_id, start_date);

-- The Pause that Skipped this Occurrence (Fixed only). Excused Occurrences
-- keep it NULL and set excused_at instead, so the two are distinguishable.
ALTER TABLE occurrences
  ADD COLUMN skipped_by_pause_id uuid REFERENCES pauses(id),
  ADD CONSTRAINT occurrences_pause_skip CHECK (
    skipped_by_pause_id IS NULL OR (status = 'skipped' AND excused_at IS NULL)
  );

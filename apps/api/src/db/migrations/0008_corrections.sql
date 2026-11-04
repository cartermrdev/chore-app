-- Corrections (#23): Void/Undo keep the voided Completion; Excuse records who
-- moved an Occurrence to Skipped, when, and why. Pause-Skipped Occurrences
-- leave the excuse columns null.

ALTER TABLE completions
  ADD CONSTRAINT completions_voided_by_with_voided_at CHECK ((voided_at IS NULL) = (voided_by IS NULL));

ALTER TABLE occurrences
  ADD COLUMN excused_at  timestamptz,
  ADD COLUMN excused_by  uuid REFERENCES persons(id),
  ADD COLUMN excuse_note text,
  ADD CONSTRAINT occurrences_excuse_complete CHECK (
    (excused_at IS NULL AND excused_by IS NULL AND excuse_note IS NULL)
    OR (excused_at IS NOT NULL AND excused_by IS NOT NULL AND excuse_note IS NOT NULL AND status = 'skipped')
  );

-- History (#25) lists Completions per Occurrence, including voided ones.
CREATE INDEX IF NOT EXISTS completions_occurrence ON completions (occurrence_id);

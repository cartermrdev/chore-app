-- Tag lifecycle and Archive (#22).
-- A Tag or Chore may be hard-deleted only when no Completion records it, so
-- "does this Tag have history?" must be cheap. Archive unlinks Tags by setting
-- tags.chore_id to NULL (no schema change needed); claiming an Unregistered
-- Tag inserts a row under the scanned ID (tags.id is already the primary key).
CREATE INDEX completions_tag ON completions (tag_id) WHERE tag_id IS NOT NULL;
CREATE INDEX completions_occurrence ON completions (occurrence_id);

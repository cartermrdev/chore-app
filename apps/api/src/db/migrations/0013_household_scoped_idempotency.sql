-- Idempotency records belong to a Household (ADR 0002: People span
-- Households, so a Person's key in one Household must never replay a result
-- from another). The key becomes (household_id, recorder_id, idempotency_key).
--
-- Existing rows are retry records, only useful for the few seconds a client
-- retries. Those whose stored result names a Completion get that Completion's
-- Household; the rest (e.g. nothing_due) cannot be attributed and are dropped.

ALTER TABLE completion_requests ADD COLUMN household_id uuid REFERENCES households(id);

UPDATE completion_requests r SET household_id = c.household_id
FROM completions c
WHERE c.id::text = r.result #>> '{completion,id}';

DELETE FROM completion_requests WHERE household_id IS NULL;

ALTER TABLE completion_requests
  ALTER COLUMN household_id SET NOT NULL,
  DROP CONSTRAINT completion_requests_pkey,
  ADD PRIMARY KEY (household_id, recorder_id, idempotency_key);

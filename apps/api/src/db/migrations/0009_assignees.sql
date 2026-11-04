-- Assignees (#20). A Chore without Time Slots may have an Assignee; Time Slot
-- Assignees live in chores.schedule (slots[].assigneeId). The materialiser
-- copies the Assignee onto each Occurrence when it creates it, so later
-- changes apply only from the next Occurrence.

ALTER TABLE chores ADD COLUMN assignee_id uuid REFERENCES persons(id);

ALTER TABLE occurrences ADD COLUMN assignee_id uuid REFERENCES persons(id);

CREATE INDEX occurrences_assignee ON occurrences (household_id, assignee_id, window_start)
  WHERE assignee_id IS NOT NULL;

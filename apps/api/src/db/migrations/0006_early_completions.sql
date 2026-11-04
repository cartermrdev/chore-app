-- Early Completion: a Completion deliberately recorded for an Occurrence that
-- was not yet due (completed_at before the Occurrence's window_start). Only
-- the explicit "Complete early" requests create one; a Scan never does.
ALTER TABLE completions ADD COLUMN early boolean NOT NULL DEFAULT false;

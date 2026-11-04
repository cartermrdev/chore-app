-- History views (#25): Completions made in a date range, per Household and per Completer.
CREATE INDEX completions_household_completed ON completions (household_id, completed_at);
CREATE INDEX completions_completer_completed ON completions (completer_id, completed_at);

-- Add optional survey_id to bails to support per-survey bail definitions.
-- NULL means the bail applies globally (all surveys for the user).
ALTER TABLE chatroach.bails ADD COLUMN IF NOT EXISTS survey_id UUID REFERENCES chatroach.surveys(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_bails_survey ON chatroach.bails (survey_id) STORING (name, enabled, definition, destination_form);

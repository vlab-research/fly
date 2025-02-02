SET enable_experimental_alter_column_type_general = true;
ALTER TABLE chatroach.survey_settings ALTER COLUMN off_time type TIMESTAMPTZ;
SET enable_experimental_alter_column_type_general = false;

ALTER TABLE chatroach.survey_settings ADD COLUMN surveyid UUID UNIQUE REFERENCES chatroach.surveys(id) ON DELETE CASCADE;





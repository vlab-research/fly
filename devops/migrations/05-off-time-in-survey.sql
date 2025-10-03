SET enable_experimental_alter_column_type_general = true;
ALTER TABLE chatroach.survey_settings ALTER COLUMN off_time type TIMESTAMPTZ;
SET enable_experimental_alter_column_type_general = false;

ALTER TABLE chatroach.survey_settings ADD COLUMN surveyid UUID UNIQUE REFERENCES chatroach.surveys(id) ON DELETE CASCADE;

ALTER TABLE chatroach.survey_settings ALTER COLUMN userid DROP NOT NULL;
ALTER TABLE chatroach.survey_settings ALTER COLUMN shortcode DROP NOT NULL;

-- Migrate existing data to use surveyid
INSERT INTO chatroach.survey_settings (off_time, timeouts, surveyid)
SELECT st.off_time, st.timeouts, s.id
FROM chatroach.survey_settings st
JOIN chatroach.surveys s ON st.userid = s.userid AND st.shortcode = s.shortcode;

DELETE FROM chatroach.survey_settings WHERE surveyid IS NULL;

-- Drop old columns now that data is migrated
SET sql_safe_updates = false;
ALTER TABLE chatroach.survey_settings DROP COLUMN userid;
ALTER TABLE chatroach.survey_settings DROP COLUMN shortcode;
SET sql_safe_updates = true;




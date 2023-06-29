-- Create Table for survey settings 
CREATE TABLE IF NOT EXISTS chatroach.survey_settings(
    userid UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
    shortcode VARCHAR NOT NULL,
    timeouts JSON,
    off_time VARCHAR,
    CONSTRAINT unique_settings UNIQUE(userid, shortcode)
);

GRANT SELECT ON TABLE chatroach.survey_settings to chatreader;
GRANT INSERT,SELECT,UPDATE ON TABLE chatroach.survey_settings to chatroach;

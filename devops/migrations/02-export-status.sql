-- Create Table for export statuses
CREATE TABLE IF NOT EXISTS chatroach.export_status(
    updated TIMESTAMPTZ DEFAULT now() ON UPDATE now(),
    user_id VARCHAR NOT NULL,
    survey_id VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    export_link VARCHAR NOT NULL,
    CONSTRAINT unique_status UNIQUE(survey_id, user_id)
);

GRANT SELECT ON TABLE chatroach.export_status to chatreader;
GRANT INSERT,SELECT,UPDATE ON TABLE chatroach.export_status to chatroach;

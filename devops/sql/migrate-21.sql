CREATE TABLE chatroach.survey_metadata (
	surveyid UUID NOT NULL REFERENCES chatroach.surveys(id) ON DELETE CASCADE,
	off_date TIMESTAMPTZ NOT NULL,
	PRIMARY KEY(surveyid)
);

GRANT INSERT, SELECT, UPDATE ON TABLE chatroach.surveys_metadata to chatroach;

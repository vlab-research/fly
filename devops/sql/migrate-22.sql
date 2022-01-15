CREATE TABLE chatroach.surveys_metadata (
	surveyid UUID NOT NULL REFERENCES chatroach.surveys(id) ON DELETE CASCADE,
	off_date TIMESTAMPTZ NOT NULL,
	PRIMARY KEY(surveyid)
);

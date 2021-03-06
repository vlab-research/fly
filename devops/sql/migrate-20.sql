ALTER TABLE chatroach.states ADD COLUMN next_retry TIMESTAMP AS ((FLOOR((POWER(2, (CASE WHEN JSON_ARRAY_LENGTH(state_json->'retries') <= 16 THEN JSON_ARRAY_LENGTH(state_json->'retries') ELSE 16 END))*60000 + (state_json->'retries'->>-1)::INT)::INT)/1000)::INT::TIMESTAMP) STORED;

CREATE INDEX ON chatroach.states (current_state, error_tag, updated, next_retry);
CREATE INDEX ON chatroach.states (current_state, fb_error_code, updated, next_retry);

-- Testcontainers schema for facebot integration tests
-- CockroachDB-compatible, based on minimal-schema.sql and create-states-table.sql

CREATE DATABASE IF NOT EXISTS chatroach;

CREATE TABLE IF NOT EXISTS chatroach.users(
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   email VARCHAR UNIQUE NOT NULL,
   created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chatroach.surveys(
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
   formid VARCHAR,
   form JSONB NOT NULL,
   messages JSONB,
   shortcode VARCHAR NOT NULL,
   userid UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
   title VARCHAR,
   translation_conf JSONB,
   UNIQUE(userid, shortcode)
);

CREATE TABLE IF NOT EXISTS chatroach.messages(
   content VARCHAR NOT NULL,
   userid VARCHAR NOT NULL,
   timestamp TIMESTAMPTZ NOT NULL,
   hsh INT AS (fnv64a(content)) STORED,
   PRIMARY KEY (hsh, userid)
);

CREATE TABLE IF NOT EXISTS chatroach.responses(
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   userid VARCHAR NOT NULL,
   surveyid UUID REFERENCES chatroach.surveys(id) ON DELETE CASCADE,
   question_ref VARCHAR NOT NULL,
   question_idx INT NOT NULL,
   response VARCHAR,
   parent_shortcode VARCHAR,
   translated_response VARCHAR,
   pageid VARCHAR,
   timestamp TIMESTAMPTZ NOT NULL,
   metadata JSONB
);

CREATE TABLE IF NOT EXISTS chatroach.states(
   userid VARCHAR NOT NULL,
   pageid VARCHAR NOT NULL,
   updated TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
   state_json JSONB NOT NULL,
   surveyid INT REFERENCES chatroach.surveys(id) ON DELETE CASCADE,
   fb_error_code VARCHAR,
   current_state VARCHAR AS (state_json->>'current') STORED,
   current_form VARCHAR AS (CASE
      WHEN state_json->'surveys' != 'null'
        THEN state_json->'surveys'->-1->>'form'
      ELSE NULL
   END) STORED,
   prev_form VARCHAR AS (CASE
      WHEN state_json->'surveys' != 'null' AND JSON_ARRAY_LENGTH(state_json->'surveys') >= 2
        THEN state_json->'surveys'->-2->>'form'
      ELSE NULL
   END) STORED,
   previous VARCHAR AS (CASE
      WHEN JSON_ARRAY_LENGTH(state_json->'state-history') > 1
        THEN (state_json->'state-history'->-2)::VARCHAR
      ELSE NULL
   END) STORED,
   previous_with_token VARCHAR AS (CASE
      WHEN state_json->'md'->>'e_form_token' IS NOT NULL THEN (CASE
          WHEN JSON_ARRAY_LENGTH(state_json->'state-history') > 1
            THEN (state_json->'state-history'->-2)::VARCHAR
          ELSE NULL
       END)
      ELSE NULL
   END) STORED,
   previous_is_followup VARCHAR AS (CASE
      WHEN state_json->'md'->>'e_is_followup' = 'true' THEN (CASE
          WHEN JSON_ARRAY_LENGTH(state_json->'state-history') > 1
            THEN (state_json->'state-history'->-2)::VARCHAR
          ELSE NULL
       END)
      ELSE NULL
   END) STORED,
   form_start_time TIMESTAMP AS (CASE
      WHEN state_json->'surveys' != 'null' AND state_json->'surveys'->-1->>'start_ts' != 'null'
        THEN parse_timestamp(state_json->'surveys'->-1->>'start_ts')
      ELSE NULL
   END) STORED,
   error_tag VARCHAR AS (state_json->'md'->>'e_error_tag') STORED,
   stuck_on_question VARCHAR AS (CASE
      WHEN state_json->'state-history' != 'null' AND state_json->'qa' != 'null'
        THEN state_json->'qa'->-1->>0
      ELSE NULL
   END) STORED,
   next_retry TIMESTAMP AS (
    (FLOOR(
        (POWER(2, (CASE
                    WHEN JSON_ARRAY_LENGTH(state_json->'retries') <= 16
                      THEN JSON_ARRAY_LENGTH(state_json->'retries')
                    ELSE 16
                  END)
              )*60000 + (state_json->'retries'->>-1)::INT
        )::INT)/1000)::INT::TIMESTAMP
   ) STORED,
   payment_error_code VARCHAR AS (CASE
    WHEN state_json->'md'->'e_payment_reloadly_error_code' IS NOT NULL AND (state_json->'md'->>'e_payment_reloadly_success')::BOOL is not true
      THEN state_json->'md'->>'e_payment_reloadly_error_code'
    ELSE NULL
   END) STORED,
   PRIMARY KEY (userid, pageid),
   INDEX (current_state, updated),
   INDEX (current_state, current_form, updated),
   INDEX (previous_with_token, previous_is_followup, form_start_time, current_state, updated) STORING (state_json),
   INDEX (error_tag, current_state, current_form, updated),
   INDEX (stuck_on_question, current_state, current_form, updated),
   INDEX (current_state, error_tag, updated, next_retry),
   INDEX (current_form, payment_error_code) STORING (state_json),
   INDEX (payment_error_code) STORING (state_json),
   INVERTED INDEX (state_json)
);

CREATE TABLE IF NOT EXISTS chatroach.credentials(
   userid UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
   entity VARCHAR NOT NULL,
   key VARCHAR NOT NULL,
   details JSONB,
   created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
   PRIMARY KEY (userid, entity, key)
);

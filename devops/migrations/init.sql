/*
 *****************
 * chatroach database
 *****************
 */
CREATE DATABASE IF NOT EXISTS chatroach;

/*
 *****************
 * messages
 *****************
 */
-- TODO: add userid that's not the end user, but the survey owner...
-- OR JUST THE PAGEID, FOR EXAMPLE!
-- TODO: Make primary key id + userid!
-- PRIMARY KEY (userid, timestamp, question_ref), -- bit hacky, remove timestamp?
CREATE TABLE IF NOT EXISTS chatroach.messages(
       id BIGINT,
       content VARCHAR NOT NULL,
       userid VARCHAR NOT NULL,
       timestamp TIMESTAMPTZ NOT NULL,
       hsh INT AS (fnv64a(content)) STORED NOT NULL,
       CONSTRAINT "primary" PRIMARY KEY (hsh, userid),
       INDEX (userid) STORING (content, timestamp),
       INDEX (userid, timestamp ASC) STORING (content),
       INDEX (timestamp DESC) STORING (content)
);

/*
 *****************
 * users
 *****************
 */
CREATE TABLE IF NOT EXISTS chatroach.users(
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       email VARCHAR NOT NULL UNIQUE
);

/*
 *****************
 * surveys
 *****************
 */
CREATE TABLE IF NOT EXISTS chatroach.surveys(
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       created TIMESTAMPTZ NOT NULL,
       formid VARCHAR NOT NULL,
       form VARCHAR NOT NULL,
       messages VARCHAR,
       shortcode VARCHAR NOT NULL,
       title VARCHAR NOT NULL,
       form_json JSON AS (form::JSON) STORED,
       messages_json JSON AS (messages::JSON) STORED,
       userid UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
       has_followup BOOL AS (messages::JSON->>'label.buttonHint.default' IS NOT NULL) STORED,
       metadata JSONB NOT NULL DEFAULT '{}',
       survey_name VARCHAR NOT NULL DEFAULT 'default',
       translation_conf JSONB NOT NULL DEFAULT '{}',
       INDEX (shortcode, userid, created DESC) STORING (formid, form, messages, title, form_json),
       INDEX (has_followup, shortcode, userid, created desc)
);

/*
 *****************
 * responses
 *****************
 */
CREATE TABLE IF NOT EXISTS chatroach.responses (
       parent_surveyid UUID REFERENCES chatroach.surveys(id),
       parent_shortcode VARCHAR NOT NULL, -- implicit reference to surveys.shortcode
       surveyid UUID NOT NULL REFERENCES chatroach.surveys(id),
       shortcode VARCHAR NOT NULL, -- implicit reference to surveys.shortcode
       flowid INT NOT NULL,
       userid VARCHAR NOT NULL,
       question_ref VARCHAR NOT NULL,
       question_idx INT NOT NULL,
       question_text VARCHAR NOT NULL,
       response VARCHAR NOT NULL,
       seed INT NOT NULL,
       pageid VARCHAR,
       clusterid VARCHAR AS (metadata->>'clusterid') STORED,
       timestamp TIMESTAMPTZ NOT NULL,
       PRIMARY KEY (userid, timestamp, question_ref),
       metadata JSONB,
       translated_response VARCHAR,
       INVERTED INDEX (metadata),
       INDEX (shortcode, question_ref, response, clusterid, timestamp),
       INDEX (surveyid, userid, timestamp asc, question_ref) storing (
        parent_surveyid, 
        parent_shortcode, 
        shortcode, 
        flowid, 
        question_idx, 
        question_text, 
        response, 
        seed, 
        metadata, 
        pageid, 
        clusterid, 
        translated_response
      )
);

/*
 *****************
 * states
 *****************
 */
CREATE TABLE IF NOT EXISTS chatroach.states(
       userid VARCHAR NOT NULL,
       pageid VARCHAR NOT NULL NOT NULL,
       updated TIMESTAMPTZ NOT NULL,
       current_state VARCHAR NOT NULL,
       state_json JSON NOT NULL,
       PRIMARY KEY (userid, pageid),
       previous_is_followup BOOL AS (state_json->'previousOutput'->>'followUp' IS NOT NULL) STORED,
       previous_with_token BOOL AS (state_json->'previousOutput'->>'token' IS NOT NULL) STORED,
       form_start_time TIMESTAMPTZ AS (CEILING((state_json->'md'->>'startTime')::INT/1000)::INT::TIMESTAMPTZ) STORED,
       current_form varchar AS (state_json->'forms'->>-1) STORED,
       error_tag VARCHAR AS (state_json->'error'->>'tag') STORED,
       fb_error_code varchar AS (state_json->'error'->>'code') STORED,
       stuck_on_question VARCHAR AS (CASE 
          WHEN (state_json->'qa'->-1->>0) = (state_json->'qa'->-2->>0) 
            AND (state_json->'qa'->-2->>0) = (state_json->'qa'->-3->>0) 
              THEN state_json->'qa'->-1->>0 
          ELSE NULL 
       END) STORED,
       timeout_date TIMESTAMPTZ AS (CASE
          WHEN state_json->'wait'->>'type' = 'timeout' AND state_json->'wait'->'value'->>'type' = 'absolute' 
            THEN (timezone('UCT',parse_timestamp(state_json->'wait'->'value'->>'timeout')))
          WHEN state_json->'wait'->>'type' = 'timeout' AND state_json->'wait'->'value'->>'type' = 'relative' 
            THEN  (timezone('UCT',(CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + (state_json->'wait'->'value'->>'timeout')::INTERVAL)))
          WHEN state_json->'wait'->>'type' = 'timeout' 
            THEN (timezone('UCT', (CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + (state_json->'wait'->>'value')::INTERVAL)))
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
       INDEX (current_state, updated),
       INDEX (current_state, current_form, updated),
       INDEX (previous_with_token, previous_is_followup, form_start_time, current_state, updated) STORING (state_json),
       INDEX (error_tag, current_state, current_form, updated),
       INDEX (stuck_on_question, current_state, current_form, updated),
       INDEX (current_state, timeout_date) STORING (state_json),
       INDEX (current_state, error_tag, updated, next_retry),
       INDEX (current_form, payment_error_code) STORING (state_json),
       INDEX (payment_error_code) STORING (state_json),
       INVERTED INDEX (state_json)
);


/*
 *****************
 * credentials
 *****************
 */
CREATE TABLE IF NOT EXISTS chatroach.credentials(
       userid UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
       entity VARCHAR NOT NULL,
       key VARCHAR NOT NULL,
       created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
       details JSONB NOT NULL,
       facebook_page_id VARCHAR AS (CASE WHEN entity = 'facebook_page' THEN details->>'id' ELSE NULL END) STORED,
       UNIQUE(entity, key),
       INDEX (userid, entity, key, created desc) STORING (details),
       INDEX (facebook_page_id) STORING (details, key, userid),
       CONSTRAINT unique_facebook_page UNIQUE(facebook_page_id),
       CONSTRAINT unique_entity_key_per_user UNIQUE(userid, entity, key)
);

/*
 *****************
 * campaigns
 *****************
 */
CREATE TABLE IF NOT EXISTS chatroach.campaigns(
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       userid UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
       created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
       name VARCHAR NOT NULL,
       active BOOL NOT NULL DEFAULT TRUE,
       credentials_key VARCHAR,
       credentials_entity VARCHAR DEFAULT 'facebook_ad_user',
       UNIQUE (userid, name),
       INDEX (userid, credentials_entity, credentials_key),
       CONSTRAINT credentials_key_exists FOREIGN KEY (userid, credentials_entity, credentials_key) REFERENCES chatroach.credentials (userid, entity, KEY)
);

/*
 *****************
 * campaigns_confs
 *****************
 */
CREATE TABLE IF NOT EXISTS chatroach.campaign_confs(
       campaignid UUID NOT NULL REFERENCES chatroach.campaigns(id) ON DELETE CASCADE,
       created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
       conf_type VARCHAR NOT NULL,
       entity_name VARCHAR,
       conf JSONB NOT NULL,
       INDEX (campaignid, conf_type, created desc) STORING (entity_name, conf)
);

/*
 *****************
 * adopt_reports
 *****************
 */
CREATE TABLE IF NOT EXISTS chatroach.adopt_reports(
       campaignid UUID NOT NULL REFERENCES chatroach.campaigns ON DELETE CASCADE,
       created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
       report_type VARCHAR NOT NULL,
       details JSONB NOT NULL
);

/*
 *****************
 * chatroach
 * user creation and permissions
 *****************
 */
CREATE USER IF NOT EXISTS chatroach;
GRANT INSERT,SELECT ON TABLE chatroach.messages to chatroach;
GRANT INSERT,SELECT ON TABLE chatroach.responses to chatroach;
GRANT INSERT,SELECT,UPDATE ON TABLE chatroach.users to chatroach;
GRANT INSERT,SELECT,UPDATE ON TABLE chatroach.surveys to chatroach;
GRANT INSERT,SELECT,UPDATE ON TABLE chatroach.states to chatroach;
GRANT INSERT,SELECT,UPDATE ON TABLE chatroach.credentials to chatroach;
GRANT INSERT,SELECT ON TABLE chatroach.campaigns to chatroach;
GRANT INSERT,SELECT ON TABLE chatroach.campaign_confs to chatroach;
GRANT INSERT,SELECT ON TABLE chatroach.adopt_reports to chatroach;

/*
 *****************
 * chatreader
 * user creation and permissions
 *****************
 */
CREATE USER IF NOT EXISTS chatreader;
GRANT SELECT ON TABLE chatroach.messages to chatreader;
GRANT SELECT ON TABLE chatroach.responses to chatreader;
GRANT SELECT ON TABLE chatroach.users to chatreader;
GRANT SELECT ON TABLE chatroach.surveys to chatreader;
GRANT SELECT ON TABLE chatroach.credentials to chatreader;
GRANT INSERT,SELECT ON TABLE chatroach.campaigns to chatreader;
GRANT INSERT,SELECT ON TABLE chatroach.campaign_confs to chatreader;
GRANT SELECT ON TABLE chatroach.adopt_reports to chatreader;

/*
 *****************
 * adopt
 * user creation and permissions
 *****************
 */
CREATE USER IF NOT EXISTS adopt;
GRANT SELECT ON TABLE chatroach.responses to adopt;
GRANT SELECT ON TABLE chatroach.credentials to adopt;
GRANT SELECT ON TABLE chatroach.surveys to adopt;
GRANT SELECT ON TABLE chatroach.campaigns to adopt;
GRANT SELECT ON TABLE chatroach.campaign_confs to adopt;
GRANT INSERT,SELECT ON TABLE chatroach.adopt_reports to adopt;


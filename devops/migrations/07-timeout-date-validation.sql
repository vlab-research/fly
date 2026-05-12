/*
 * Migration: Make timeout_date computed column fault-tolerant
 *
 * Problem: The timeout_date column casts user-provided strings directly to
 * ::INTERVAL, which causes INSERT failures if the string is not a valid
 * PostgreSQL interval format.
 *
 * Solution: Add regex validation before casting to INTERVAL. Invalid formats
 * now return NULL instead of causing an error.
 */

-- Temporarily disable safe updates for schema changes
SET sql_safe_updates = false;

-- Drop the index that depends on timeout_date
DROP INDEX IF EXISTS chatroach.states_current_state_timeout_date_idx;

-- Drop the old column
ALTER TABLE chatroach.states DROP COLUMN IF EXISTS timeout_date;

-- Add the new fault-tolerant computed column
-- Validates interval strings match pattern like: "1 hour", "2 days", "30 minutes"
ALTER TABLE chatroach.states ADD COLUMN timeout_date TIMESTAMPTZ AS (CASE
   WHEN state_json->'wait'->>'type' = 'timeout'
        AND state_json->'wait'->'value'->>'type' = 'absolute'
     THEN (timezone('UCT', parse_timestamp(state_json->'wait'->'value'->>'timeout')))
   WHEN state_json->'wait'->>'type' = 'timeout'
        AND state_json->'wait'->'value'->>'type' = 'relative'
        AND (state_json->'wait'->'value'->>'timeout') ~ '^\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)$'
     THEN (timezone('UCT', (CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + parse_interval(state_json->'wait'->'value'->>'timeout'))))
   WHEN state_json->'wait'->>'type' = 'timeout'
        AND (state_json->'wait'->>'value') ~ '^\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)$'
     THEN (timezone('UCT', (CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + parse_interval(state_json->'wait'->>'value'))))
   ELSE NULL
END) STORED;

-- Recreate the index
CREATE INDEX states_current_state_timeout_date_idx ON chatroach.states (current_state, timeout_date) STORING (state_json);

-- Re-enable safe updates
SET sql_safe_updates = true;

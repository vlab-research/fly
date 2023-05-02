-- DROP OLD INDEX/COLUMN FOR TIMEOUTS

DROP INDEX IF EXISTS states_current_state_timeout_date_idx;

SET sql_safe_updates=FALSE;
ALTER TABLE chatroach.states DROP COLUMN timeout_date;
SET sql_safe_updates=TRUE;

-- CREATE NEW INDEX/COLUMN FOR TIMEOUTS
ALTER TABLE chatroach.states ADD COLUMN timeout_date TIMESTAMPTZ AS (
CASE
  WHEN state_json->'wait'->>'type' = 'timeout' AND state_json->'wait'->'value'->>'type' = 'absolute' 
    THEN (timezone('UCT',parse_timestamp(state_json->'wait'->'value'->>'timeout')))
  WHEN state_json->'wait'->>'type' = 'timeout' AND state_json->'wait'->'value'->>'type' = 'relative' 
    THEN  (timezone('UCT',(CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + (state_json->'wait'->'value'->>'timeout')::INTERVAL)))
  WHEN state_json->'wait'->>'type' = 'timeout' 
    THEN (timezone('UCT', (CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + (state_json->'wait'->>'value')::INTERVAL)))
  ELSE NULL
END) STORED;

CREATE INDEX ON chatroach.states (current_state, timeout_date) STORING (state_json);

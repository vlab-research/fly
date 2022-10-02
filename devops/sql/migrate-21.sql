ALTER TABLE chatroach.states ADD COLUMN payment_error_code VARCHAR AS (CASE
      WHEN state_json->'md'->'e_payment_reloadly_error_code' IS NOT NULL AND (state_json->'md'->>'e_payment_reloadly_success')::BOOL is not true THEN state_json->'md'->>'e_payment_reloadly_error_code'
      ELSE NULL
END) STORED;

CREATE INDEX ON chatroach.states (current_form, payment_error_code) STORING (state_json);
CREATE INDEX ON chatroach.states (payment_error_code) STORING (state_json);

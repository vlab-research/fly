-- 33-states-last-inbound.sql: expose when the respondent last wrote to us.
--
-- Replybot stamps state_json.lastInbound (epoch ms) on every event that is
-- the respondent's own act -- referral, opt-in, text, media, postback, quick
-- reply, reaction -- and on nothing else (machine.js stampInbound). It is what
-- the WhatsApp and Messenger 24-hour messaging windows count from, which
-- `updated` is not: `updated` moves on delivery receipts, machine reports and
-- dean's own sweeps. Same epoch-ms -> TIMESTAMPTZ shape as form_start_time.
--
-- Dean's FollowUps reads it in place of `updated`. NULL for rows predating
-- the stamp, and NULL means never followed up: those participants have all
-- been nudged already or are stale, and they get the column the next time
-- they write.
ALTER TABLE chatroach.states ADD COLUMN IF NOT EXISTS last_inbound TIMESTAMPTZ
  AS (CEILING((state_json->>'lastInbound')::INT8 / 1000)::INT8::TIMESTAMPTZ) STORED;

-- Serves FollowUps' equality predicates then its last_inbound range; STORING
-- state_json covers the question and the answered-anything check. The older
-- (previous_with_token, previous_is_followup, form_start_time, current_state,
-- updated) index in 01-init.sql served the `updated`-based query and stays
-- until nothing reads it.
CREATE INDEX IF NOT EXISTS states_followup_idx
  ON chatroach.states (current_state, previous_is_followup, previous_with_token, last_inbound)
  STORING (state_json);

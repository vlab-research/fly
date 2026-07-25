-- 23-states-errored-at.sql: expose the error's occurrence time on states.
--
-- Replybot now stamps state_json.error.ts (epoch ms) when a user ENTERS the
-- ERROR/BLOCKED state (machine.js thinError). It is set once per episode,
-- preserved across Dean retries (retries re-fail with fresh content but keep
-- the original onset), and cleared with the error on genuine recovery (RESPOND).
--
-- errored_at surfaces that as a timestamp so the current-error population can be
-- aged by ONSET rather than by `updated` (which Dean re-warms on every retry —
-- the source of the alert flapping). Mirrors the epoch-ms → TIMESTAMPTZ pattern
-- of the existing form_start_time computed column.
--
-- NULL for rows predating the ts stamp; consumers COALESCE(errored_at, updated)
-- for legacy rows. (State is folded from the machine_report log, so reloaded
-- rows backfill errored_at automatically as they re-hydrate.)
ALTER TABLE chatroach.states ADD COLUMN IF NOT EXISTS errored_at TIMESTAMPTZ
  AS (ceiling((state_json->'error'->>'ts')::INT8 / 1000)::INT8::TIMESTAMPTZ) STORED;

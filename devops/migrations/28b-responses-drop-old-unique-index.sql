-- 28b-responses-drop-old-unique-index.sql  (PHASE 2 of 2)
--
-- Finish what 28a started: drop the old primary key that ALTER PRIMARY KEY left
-- behind as a unique secondary index, and prove no participant-scoped unique
-- constraint survives.
--
-- READ 28a's HEADER FIRST. It explains the whole change and why it is split.
--
-- RUN THIS ONLY AFTER the new scribble build is deployed AND verified. The whole
-- point of the split is that between 28a and 28b both the old and the new build
-- can write: the old one arbitrates on the retained unique index, the new one on
-- the new primary key. This file ends that overlap.
--
-- PRECONDITION CHECK (all must hold before running):
--
--   1. The deployed scribble carries the 4-column ON CONFLICT targets
--      (scribble/response.go, ON CONFLICT (userid, pageid, timestamp, question_ref)).
--        kubectl get deploy gbv-scribble-responses -n <ns> \
--          -o jsonpath='{.spec.template.spec.containers[0].image}'
--
--   2. It is actually healthy, not merely rolled out -- no 42P10 and no 23505:
--        kubectl logs -n <ns> deployment/gbv-scribble-responses --since=30m \
--          | grep -iE '42P10|23505'
--      Expect no output. A climbing restart count on gbv-scribble-responses
--      ALONE is the alarm; all four sinks restarting together is a shared
--      dependency blip, not this. See planning/conversation-identity.md 5.2.
--
--   3. Writes are landing -- the responses row count is advancing.
--
-- IF ANY CHECK FAILS, STOP. Staying in the 28a overlap state is safe for a
-- while; running 28b against a build that cannot use the new key is not, because
-- it removes the only arbiter the old build has and crash-loops the sink.
--
-- WHY THIS IS LOAD-BEARING AND NOT COSMETIC. Left in place, the retained unique
-- index re-imposes the exact constraint this migration set out to remove, and
-- the fix becomes a silent no-op whose colliding inserts fail 23505 instead of
-- being silently discarded. The bug would look fixed and would not be. Do not
-- skip this file, and do not leave the overlap sitting for days.
--
-- ROLLBACK. There is no clean rollback for the drop itself. If the new build
-- turns out to be broken AFTER 28b, roll forward -- redeploying the old build
-- will crash-loop it, because its 3-column ON CONFLICT no longer has an arbiter
-- (SQLSTATE 42P10, verified on vstag 2026-08-25). Recreating the index by hand
-- is possible but it re-imposes the bug:
--   CREATE UNIQUE INDEX responses_userid_timestamp_question_ref_key
--     ON chatroach.responses (userid, timestamp, question_ref);
--
-- DISK. This is a DROP INDEX, so the space returns asynchronously per the zone's
-- gc.ttlseconds (production: 90000s / 25h), not at completion.

-- ALTER PRIMARY KEY retains the OLD primary key as a UNIQUE secondary index.
-- Left in place it re-imposes the exact constraint 28a removes. Load-bearing.
DROP INDEX IF EXISTS chatroach.responses@responses_userid_timestamp_question_ref_key CASCADE;

-- Fail loudly if any unique index other than the new primary key survives.
-- Assert on the KEY COLUMNS, not the index NAME. See 27's equivalent block:
-- the name-based form raised a false alarm on production 2026-08-25, because
-- production's primary-key index is named `primary` (legacy CockroachDB
-- naming) while staging's is `responses_pkey`. Confirmed for responses
-- specifically: prod `primary`, vstag `responses_pkey`. Had this shipped
-- unchanged it would have failed here in exactly the same way.
SELECT crdb_internal.force_error(
         'XXUUU',
         'responses has a unique index that excludes pageid: ' || index_name
       )
FROM (
  SELECT index_name, array_agg(column_name ORDER BY seq_in_index) AS cols
  FROM [SHOW INDEXES FROM chatroach.responses]
  WHERE non_unique = false AND storing = false AND implicit = false
  GROUP BY index_name
)
WHERE cols != ARRAY['userid', 'timestamp', 'question_ref', 'pageid']
LIMIT 1;

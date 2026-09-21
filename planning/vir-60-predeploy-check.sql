-- VIR-60 pre-deploy check -- READ ONLY. CockroachDB.
--
-- Run this against production BEFORE deploying the exodus build that resolves a
-- bail's platform from `credentials.entity`. Nothing here writes; every
-- statement is a SELECT.
--
--   ./devops/run-prod-migration.sh is for migrations -- do NOT use it here.
--   Run this through a read-only SQL session, e.g.
--     kubectl -n <ns> exec -it <cockroach-pod> -- ./cockroach sql --insecure \
--       --database chatroach < planning/vir-60-predeploy-check.sql
--
-- What changes, and therefore what this measures:
--
--   Conditions bails: the query gains
--       INNER JOIN credentials c ON c.key = s.pageid
--         AND c.entity IN ('facebook_page','whatsapp_business')
--         AND c.userid = <bail owner>
--     Two effects. (1) Rows on an account the bail's owner does not own stop
--     matching -- today a shortcode match is global, so one owner's bail can
--     reach another owner's participants. (2) Rows on an account with no
--     messaging credential at all stop matching.
--
--   User list bails: every pageid must resolve to a messaging credential owned
--     by the bail owner, checked at create/update/preview and again at
--     execution; unresolvable targets are skipped and recorded in
--     bail_events.execution_results instead of being sent.
--
-- An empty result from every check below means the deploy changes no bail's
-- population. A non-empty result is not necessarily a regression -- the
-- excluded rows are, by definition, participants the bail should never have
-- reached -- but a human decides per bail before deploying.

---------------------------------------------------------------------------
-- CHECK 0 -- inventory: which enabled bails exist, and can check 1 bound them?
---------------------------------------------------------------------------
--
-- Check 1 bounds a conditions bail's population by the shortcodes its
-- definition names. A bail whose conditions name no form and no survey (only
-- `state`, `error_code`, `current_question`, `elapsed_time` or
-- `question_response`) is not anchored to a shortcode, so no SQL here can
-- reproduce its WHERE clause -- the clause is assembled in Go by
-- exodus/query/builder.go. Those bails are listed with anchored = false and
-- must be checked by the procedure at the bottom of this file instead.

WITH enabled_bails AS (
  SELECT
    b.id,
    b.name,
    b.user_id,
    u.email        AS owner_email,
    COALESCE(b.definition->>'type', 'conditions') AS bail_type,
    b.definition
  FROM chatroach.bails b
  JOIN chatroach.users u ON u.id = b.user_id
  WHERE b.enabled = true
)
SELECT
  eb.id,
  eb.name,
  eb.owner_email,
  eb.bail_type,
  -- NULL for user_list bails: the column only means anything for conditions.
  CASE WHEN eb.bail_type = 'conditions' THEN EXISTS (
    SELECT 1
    FROM chatroach.surveys s
    WHERE eb.definition::STRING LIKE '%"' || s.shortcode || '"%'
       OR eb.definition::STRING LIKE '%"' || s.id::STRING || '"%'
  ) END AS anchored_to_a_shortcode
FROM enabled_bails eb
ORDER BY eb.bail_type, eb.owner_email, eb.name;

---------------------------------------------------------------------------
-- CHECK 1 -- conditions bails: rows the owner-scoped join would exclude
---------------------------------------------------------------------------
--
-- The conditions themselves are built dynamically in Go, so this cannot be an
-- exact replay of each bail's WHERE clause. It is a deliberate OVER-estimate,
-- which is the safe direction: it takes every shortcode the definition names
-- (directly as a `form` value, or indirectly as a `surveyid` whose survey rows
-- carry that shortcode) and treats every states row on those shortcodes as a
-- candidate. The real WHERE clause only narrows that set further.
--
--   empty result  => the deploy excludes nothing for any anchored bail.
--   rows returned => those (bail, pageid) populations stop matching. Read
--                    `pageid_owned_by`: an email other than owner_email is a
--                    cross-tenant match that exists today; NULL means the
--                    account has no messaging credential at all (disconnected,
--                    or never connected).
--
-- `matched_rows` is an upper bound on the participants affected, not a count of
-- participants who would have been bailed this tick.

WITH enabled_conditions_bails AS (
  SELECT b.id, b.name, b.user_id, u.email AS owner_email, b.definition
  FROM chatroach.bails b
  JOIN chatroach.users u ON u.id = b.user_id
  WHERE b.enabled = true
    AND COALESCE(b.definition->>'type', 'conditions') = 'conditions'
),
-- A shortcode is "named" by a bail when it, or the id of a survey published
-- under it, appears as a quoted string anywhere in the definition. This catches
-- `{"type":"form","value":"<shortcode>"}` and
-- `{"type":"surveyid","value":"<uuid>"}` at any nesting depth without walking
-- the condition tree.
named_shortcodes AS (
  SELECT DISTINCT b.id AS bail_id, b.user_id, b.name, b.owner_email, s.shortcode
  FROM enabled_conditions_bails b
  JOIN chatroach.surveys s
    ON b.definition::STRING LIKE '%"' || s.shortcode || '"%'
    OR b.definition::STRING LIKE '%"' || s.id::STRING || '"%'
)
SELECT
  ns.bail_id,
  ns.name        AS bail_name,
  ns.owner_email,
  st.pageid,
  cu.email       AS pageid_owned_by,
  c.entity       AS pageid_entity,
  count(*)       AS matched_rows,
  count(DISTINCT st.current_form) AS distinct_forms
FROM named_shortcodes ns
JOIN chatroach.states st
  ON st.current_form = ns.shortcode
LEFT JOIN chatroach.credentials c
  ON c.key = st.pageid
 AND c.entity IN ('facebook_page', 'whatsapp_business')
LEFT JOIN chatroach.users cu
  ON cu.id = c.userid
WHERE NOT EXISTS (
  SELECT 1
  FROM chatroach.credentials own
  WHERE own.key = st.pageid
    AND own.entity IN ('facebook_page', 'whatsapp_business')
    AND own.userid = ns.user_id
)
GROUP BY ns.bail_id, ns.name, ns.owner_email, st.pageid, cu.email, c.entity
ORDER BY matched_rows DESC;

---------------------------------------------------------------------------
-- CHECK 2 -- conditions bails: platform the new query will send
---------------------------------------------------------------------------
--
-- For the rows that DO survive the join, this is the platform each bail will
-- now put on its events, next to what the old COALESCE(s.platform,'messenger')
-- would have sent. A row where they differ is a bail that has been sending the
-- wrong platform -- the bug being fixed -- so differences are expected on
-- WhatsApp accounts and on rows whose states.platform is NULL.

WITH enabled_conditions_bails AS (
  SELECT b.id, b.name, b.user_id, u.email AS owner_email, b.definition
  FROM chatroach.bails b
  JOIN chatroach.users u ON u.id = b.user_id
  WHERE b.enabled = true
    AND COALESCE(b.definition->>'type', 'conditions') = 'conditions'
),
named_shortcodes AS (
  SELECT DISTINCT b.id AS bail_id, b.user_id, b.name, b.owner_email, s.shortcode
  FROM enabled_conditions_bails b
  JOIN chatroach.surveys s
    ON b.definition::STRING LIKE '%"' || s.shortcode || '"%'
    OR b.definition::STRING LIKE '%"' || s.id::STRING || '"%'
)
SELECT *
FROM (
  SELECT
    ns.bail_id,
    ns.name AS bail_name,
    ns.owner_email,
    st.pageid,
    CASE c.entity
      WHEN 'facebook_page'     THEN 'messenger'
      WHEN 'whatsapp_business' THEN 'whatsapp'
    END                                  AS platform_after,
    COALESCE(st.platform, 'messenger')   AS platform_before,
    count(*)                             AS matched_rows
  FROM named_shortcodes ns
  JOIN chatroach.states st
    ON st.current_form = ns.shortcode
  JOIN chatroach.credentials c
    ON c.key = st.pageid
   AND c.entity IN ('facebook_page', 'whatsapp_business')
   AND c.userid = ns.user_id
  GROUP BY ns.bail_id, ns.name, ns.owner_email, st.pageid, c.entity, COALESCE(st.platform, 'messenger')
) t
ORDER BY (t.platform_after IS DISTINCT FROM t.platform_before) DESC, t.matched_rows DESC;

---------------------------------------------------------------------------
-- CHECK 3 -- user list bails: pageids that will no longer resolve
---------------------------------------------------------------------------
--
-- Every entry of every ENABLED user_list bail, with the credential its pageid
-- resolves to. A row where `resolution` is not 'ok' is a target that will be
-- skipped at execution (and would be rejected with 400 if the bail were saved
-- again through the API).
--
--   credential_not_found -- no messaging credential for this account id.
--   credential_not_owned -- the account exists but belongs to another user.
--
-- `stored_platform` is what the entry claims today. It is now ignored: the
-- credential decides. A row where stored_platform differs from
-- resolved_platform was being sent on the wrong transport.

SELECT
  b.id                       AS bail_id,
  b.name                     AS bail_name,
  u.email                    AS owner_email,
  e->>'userid'               AS userid,
  e->>'pageid'               AS pageid,
  e->>'shortcode'            AS shortcode,
  e->>'platform'             AS stored_platform,
  CASE c.entity
    WHEN 'facebook_page'     THEN 'messenger'
    WHEN 'whatsapp_business' THEN 'whatsapp'
  END                        AS resolved_platform,
  CASE
    WHEN c.key IS NULL       THEN 'credential_not_found'
    WHEN c.userid <> b.user_id THEN 'credential_not_owned'
    ELSE 'ok'
  END                        AS resolution
FROM chatroach.bails b
JOIN chatroach.users u ON u.id = b.user_id
CROSS JOIN LATERAL jsonb_array_elements(b.definition->'user_list'->'users') e
LEFT JOIN chatroach.credentials c
  ON c.key = e->>'pageid'
 AND c.entity IN ('facebook_page', 'whatsapp_business')
WHERE b.enabled = true
  AND b.definition->>'type' = 'user_list'
ORDER BY resolution, bail_name, pageid;

---------------------------------------------------------------------------
-- CHECK 4 -- user list bails: summary, including disabled ones
---------------------------------------------------------------------------
--
-- The same question one row per bail, over ALL user_list bails rather than
-- only the enabled ones, because a disabled bail is usually a finished batch
-- that someone may re-enable. A bail with bad_pageids > 0 will be rejected on
-- its next save through the API until its pageids are fixed.

SELECT
  b.id           AS bail_id,
  b.name         AS bail_name,
  u.email        AS owner_email,
  b.enabled,
  count(*)       AS entries,
  count(*) FILTER (
    WHERE NOT EXISTS (
      SELECT 1 FROM chatroach.credentials c
      WHERE c.key = e->>'pageid'
        AND c.entity IN ('facebook_page', 'whatsapp_business')
        AND c.userid = b.user_id
    )
  )              AS bad_pageids,
  count(*) FILTER (WHERE e ? 'platform') AS entries_carrying_a_platform_field
FROM chatroach.bails b
JOIN chatroach.users u ON u.id = b.user_id
CROSS JOIN LATERAL jsonb_array_elements(b.definition->'user_list'->'users') e
WHERE b.definition->>'type' = 'user_list'
GROUP BY b.id, b.name, u.email, b.enabled
ORDER BY bad_pageids DESC, b.enabled DESC, bail_name;

---------------------------------------------------------------------------
-- Bails check 1 cannot bound (anchored_to_a_shortcode = false in check 0)
---------------------------------------------------------------------------
--
-- Their WHERE clause exists only as Go. Two workable options, in order of
-- preference:
--
-- 1. Ask the running (old) exodus what the bail matches today, before the
--    deploy, and again after:
--
--      POST /users/<owner_id>/bails/preview   {"definition": <the definition>}
--
--    and compare `count`. The preview endpoint runs the same builder the
--    executor does, so after the deploy its count reflects the owner-scoped
--    join. A drop is exactly the excluded population. Record the before-count
--    while the old build is still serving -- it cannot be recovered afterwards.
--
-- 2. Widen check 1 for that one bail by hand: replace the `named_shortcodes`
--    CTE with the bail's actual population predicate (read it off the
--    definition), keeping the `NOT EXISTS (... own.userid = <owner>)` filter,
--    which is the only part the deploy changes.
--
-- Do not try to reproduce elapsed_time or question_response conditions by hand;
-- their CTEs are account-scoped in ways that are easy to get subtly wrong. Use
-- option 1 for those.

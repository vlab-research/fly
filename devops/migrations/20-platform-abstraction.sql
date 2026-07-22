-- 20-platform-abstraction.sql
--
-- Phase 1 of the (platform, account_id) credentials keying migration.
-- See planning/whatsapp-plan.md (CHUNK 0) and
-- planning/whatsapp-account-model-design.md for full context.
--
-- Adds first-class platform keying to credentials so WhatsApp (and future
-- platforms) are queryable via WHERE platform = $1 AND account_id = $2,
-- replacing the Messenger-specific facebook_page_id computed column.
--
-- PRODUCTION-SAFE / ADDITIVE ONLY:
--   * Old facebook_page_id computed column and its constraint/index remain
--     untouched; existing consumers keep working during the dual-read window.
--   * Columns stay NULLABLE on purpose: non-messaging credentials
--     (facebook_ad_user, typeform_token, ...) have no platform/account_id.
--     Do NOT add SET NOT NULL.
--   * Phase 3 cleanup (drop facebook_page_id + unique_facebook_page) is a
--     separate, later migration — only after 2+ weeks of dual-read validation.

-- 1. Add new columns (nullable; NULL for non-platform credentials)
ALTER TABLE chatroach.credentials ADD COLUMN IF NOT EXISTS platform VARCHAR;
ALTER TABLE chatroach.credentials ADD COLUMN IF NOT EXISTS account_id VARCHAR;

-- 2. Backfill existing Messenger credentials
UPDATE chatroach.credentials
SET platform = 'messenger', account_id = details->>'id'
WHERE entity = 'facebook_page'
  AND details->>'id' IS NOT NULL
  AND platform IS NULL;

-- 3. Unique index for the new keying + fast lookup for the new query
--    pattern. A UNIQUE INDEX both enforces uniqueness (same account can't be
--    registered twice on one platform) and serves index-only reads via
--    STORING. NULLs are distinct in CockroachDB unique indexes, so rows with
--    platform IS NULL (non-platform credentials) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS unique_platform_account
  ON chatroach.credentials (platform, account_id)
  STORING (details, key, userid, entity);

-- ---------------------------------------------------------------------------
-- Post-migration validation (run manually; counts must match):
--
--   SELECT COUNT(*) FROM chatroach.credentials
--   WHERE entity = 'facebook_page' AND details->>'id' IS NOT NULL;
--
--   SELECT COUNT(*) FROM chatroach.credentials
--   WHERE platform = 'messenger' AND account_id IS NOT NULL;
--
-- Rollback (safe any time before Phase 3):
--
--   DROP INDEX chatroach.credentials@unique_platform_account;
--   ALTER TABLE chatroach.credentials DROP COLUMN platform;
--   ALTER TABLE chatroach.credentials DROP COLUMN account_id;
-- ---------------------------------------------------------------------------

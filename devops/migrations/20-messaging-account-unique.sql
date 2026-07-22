-- 20-messaging-account-unique.sql
--
-- Messaging account ID global uniqueness constraint.
--
-- INVARIANT: Account IDs are globally unique across messaging platforms.
-- For messaging entities (facebook_page, whatsapp_business), the `key` column
-- holds the platform account ID:
--   - facebook_page: key = page_id (e.g., '935593143497601')
--   - whatsapp_business: key = phone_number_id (e.g., '1023456789')
--
-- This partial unique index ENFORCES uniqueness at registration time (fail fast
-- on collision across platforms) and SERVES the account→credential lookup as an
-- index-only scan. The partial predicate keeps label-keyed credentials
-- (api_token, reloadly, secrets, typeform_token, facebook_ad_user) out of the
-- routing namespace. All messaging consumers use the uniform query:
--   SELECT ... FROM credentials
--   WHERE key = $1 AND entity IN ('facebook_page', 'whatsapp_business')
--
-- See planning/whatsapp-plan.md for rationale and design.

CREATE UNIQUE INDEX IF NOT EXISTS unique_messaging_account
  ON chatroach.credentials (key)
  STORING (details, userid)
  WHERE entity IN ('facebook_page', 'whatsapp_business');

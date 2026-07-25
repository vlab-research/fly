-- 22-account-id-rename.sql
--
-- Rename facebook_page_id to account_id for platform-agnostic messaging.
--
-- The media and message_templates tables hold platform-agnostic messaging account IDs:
--   - For Facebook: the page ID (e.g., '935593143497601')
--   - For WhatsApp: the phone_number_id (e.g., '1023456789')
--
-- These columns match credentials.key for messaging entities. Renaming completes the
-- platform abstraction for dashboard-owned tables. CockroachDB v21.2 performs RENAME COLUMN
-- as metadata-only; all dependent indexes and constraints automatically track the new name.

ALTER TABLE chatroach.media RENAME COLUMN facebook_page_id TO account_id;
ALTER TABLE chatroach.message_templates RENAME COLUMN facebook_page_id TO account_id;

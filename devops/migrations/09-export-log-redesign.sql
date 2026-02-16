/*
 * Redesign export_status as an append-only export log.
 *
 * Previously: one row per (survey_id, user_id), upserted on each export.
 * Now: every export attempt is a new row with a unique UUID id.
 *
 * Changes:
 *   1. Add 'id' column (UUID primary key) for tracking individual exports.
 *   2. Add 'source' column to distinguish 'responses' vs 'chat_log' exports.
 *   3. Drop the UNIQUE constraint on (survey_id, user_id) to allow multiple exports.
 *
 * Note: CockroachDB supports gen_random_uuid() natively.
 * Note: We keep export_type (added by previous migration if it exists) for safety,
 *       but the new 'source' column is the canonical field going forward.
 */

-- Add the UUID primary key column with auto-generated default
ALTER TABLE chatroach.export_status
    ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();

-- Add the source column (what data this export pulls from)
ALTER TABLE chatroach.export_status
    ADD COLUMN IF NOT EXISTS source VARCHAR NOT NULL DEFAULT 'responses';

-- Drop the unique constraint so multiple exports can exist per user per survey.
-- CockroachDB v21.2 requires DROP INDEX CASCADE instead of ALTER TABLE DROP CONSTRAINT
-- for unique constraints (see https://go.crdb.dev/issue-v/42840/v21.2).
DROP INDEX IF EXISTS chatroach.export_status@unique_status CASCADE;

-- Add primary key on id (only if no PK exists yet -- the original table had no PK)
-- CockroachDB requires a primary key; if one does not exist, it uses rowid implicitly.
-- We make id the explicit primary key for clarity and for use in UPDATE WHERE id = $1.
-- Note: If the table already has an implicit rowid PK, we need to handle this.
-- CockroachDB approach: add a unique index on id instead, since altering PK is complex.
CREATE UNIQUE INDEX IF NOT EXISTS idx_export_status_id ON chatroach.export_status (id);

-- Index for per-survey filtering (the primary query pattern going forward)
CREATE INDEX IF NOT EXISTS idx_export_status_survey ON chatroach.export_status (survey_id);

-- Index for per-user filtering (the global list query)
CREATE INDEX IF NOT EXISTS idx_export_status_user ON chatroach.export_status (user_id);

/*
 *****************
 * Permissions
 *****************
 */
GRANT SELECT ON TABLE chatroach.export_status TO chatreader;
GRANT INSERT, SELECT, UPDATE ON TABLE chatroach.export_status TO chatroach;

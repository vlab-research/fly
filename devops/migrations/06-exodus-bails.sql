/*
 *****************
 * EXODUS SERVICE - Bail Management System
 *****************
 *
 * This migration creates tables for the exodus service which manages
 * "bails" - conditional exits from survey flows that redirect users
 * to alternate forms when specific criteria are met.
 *
 * Tables:
 * - bails: Stores bail definitions (mutable configuration)
 * - bail_events: Audit log of bail executions (immutable)
 */

/*
 *****************
 * bails
 *****************
 *
 * Stores bail definitions - the conditions and configuration for
 * when users should be redirected out of the current survey flow.
 * This table is mutable as users can update bail configurations.
 *
 * Key fields:
 * - definition: JSONB containing the bail condition logic
 * - destination_form: The form ID users should be redirected to
 * - enabled: Allows temporarily disabling a bail without deleting it
 */
CREATE TABLE IF NOT EXISTS chatroach.bails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id UUID NOT NULL REFERENCES chatroach.surveys(id) ON DELETE CASCADE,
  name STRING NOT NULL,
  description STRING,
  enabled BOOL NOT NULL DEFAULT true,
  definition JSONB NOT NULL,
  destination_form STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Ensure unique bail names per survey
  CONSTRAINT unique_bail_per_survey UNIQUE (survey_id, name),

  -- Index for looking up bails by survey (most common query pattern)
  INDEX idx_bails_survey (survey_id) STORING (name, description, enabled, definition, destination_form, created_at, updated_at),

  -- Index for filtering by enabled status
  INDEX idx_bails_enabled (enabled, survey_id) STORING (name, definition, destination_form)
);

/*
 *****************
 * bail_events
 *****************
 *
 * Immutable audit log of bail executions. Each time a bail is evaluated
 * and potentially triggered, an event is recorded here for monitoring,
 * debugging, and analytics purposes.
 *
 * Key fields:
 * - bail_id: References the bail (nullable in case bail is deleted)
 * - event_type: Type of event (execution, error, etc.)
 * - users_matched: How many users matched the bail criteria
 * - users_bailed: How many users were actually redirected
 * - definition_snapshot: Copy of the bail definition at execution time
 * - error: Any errors that occurred during evaluation/execution
 *
 * Note: bail_id is nullable with ON DELETE SET NULL so we preserve
 * historical events even if the bail definition is deleted.
 */
CREATE TABLE IF NOT EXISTS chatroach.bail_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bail_id UUID REFERENCES chatroach.bails(id) ON DELETE SET NULL,
  survey_id UUID NOT NULL,
  bail_name STRING NOT NULL,
  event_type STRING NOT NULL DEFAULT 'execution',
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  users_matched INT NOT NULL DEFAULT 0,
  users_bailed INT NOT NULL DEFAULT 0,
  definition_snapshot JSONB NOT NULL,
  error JSONB,

  -- Index for bail-specific event history (most recent first)
  INDEX idx_bail_events_bail (bail_id, timestamp DESC) STORING (event_type, users_matched, users_bailed, definition_snapshot, error),

  -- Index for survey-level event history
  INDEX idx_bail_events_survey (survey_id, timestamp DESC) STORING (bail_id, bail_name, event_type, users_matched, users_bailed),

  -- Index for time-based queries (monitoring/analytics)
  INDEX idx_bail_events_timestamp (timestamp DESC) STORING (bail_id, survey_id, bail_name, event_type, users_matched, users_bailed)
);

/*
 *****************
 * chatroach user permissions
 *****************
 *
 * Grant appropriate permissions to the chatroach user for the exodus tables.
 * The chatroach user needs full CRUD access to manage bails and log events.
 */
GRANT INSERT, SELECT, UPDATE, DELETE ON TABLE chatroach.bails TO chatroach;
GRANT INSERT, SELECT ON TABLE chatroach.bail_events TO chatroach;

/*
 *****************
 * chatreader user permissions
 *****************
 *
 * Grant read-only access to the chatreader user for analytics/reporting.
 */
GRANT SELECT ON TABLE chatroach.bails TO chatreader;
GRANT SELECT ON TABLE chatroach.bail_events TO chatreader;

/*
 *****************
 * adopt user permissions
 *****************
 *
 * The adopt user may need read access for integration purposes.
 */
GRANT SELECT ON TABLE chatroach.bails TO adopt;
GRANT SELECT ON TABLE chatroach.bail_events TO adopt;

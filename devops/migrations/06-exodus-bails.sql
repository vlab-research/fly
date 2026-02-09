DROP TABLE IF EXISTS chatroach.bail_events;
DROP TABLE IF EXISTS chatroach.bails;

CREATE TABLE IF NOT EXISTS chatroach.bails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
  name STRING NOT NULL,
  description STRING,
  enabled BOOL NOT NULL DEFAULT true,
  definition JSONB NOT NULL,
  destination_form STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT unique_bail_per_user UNIQUE (user_id, name),
  INDEX idx_bails_user (user_id) STORING (name, description, enabled, definition, destination_form, created_at, updated_at),
  INDEX idx_bails_enabled (enabled, user_id) STORING (name, definition, destination_form)
);

CREATE TABLE IF NOT EXISTS chatroach.bail_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bail_id UUID REFERENCES chatroach.bails(id) ON DELETE SET NULL,
  user_id UUID NOT NULL,
  bail_name STRING NOT NULL,
  event_type STRING NOT NULL DEFAULT 'execution',
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  users_matched INT NOT NULL DEFAULT 0,
  users_bailed INT NOT NULL DEFAULT 0,
  definition_snapshot JSONB NOT NULL,
  error JSONB,

  INDEX idx_bail_events_bail (bail_id, timestamp DESC) STORING (event_type, users_matched, users_bailed, definition_snapshot, error),
  INDEX idx_bail_events_user (user_id, timestamp DESC) STORING (bail_id, bail_name, event_type, users_matched, users_bailed),
  INDEX idx_bail_events_timestamp (timestamp DESC) STORING (bail_id, user_id, bail_name, event_type, users_matched, users_bailed)
);

GRANT INSERT, SELECT, UPDATE, DELETE ON TABLE chatroach.bails TO chatroach;
GRANT INSERT, SELECT ON TABLE chatroach.bail_events TO chatroach;
GRANT SELECT ON TABLE chatroach.bails TO chatreader;
GRANT SELECT ON TABLE chatroach.bail_events TO chatreader;
GRANT SELECT ON TABLE chatroach.bails TO adopt;
GRANT SELECT ON TABLE chatroach.bail_events TO adopt;

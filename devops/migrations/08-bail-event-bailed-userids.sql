ALTER TABLE chatroach.bail_events
  ADD COLUMN IF NOT EXISTS execution_results JSONB;

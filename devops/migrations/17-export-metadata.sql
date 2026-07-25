ALTER TABLE chatroach.export_status
  ADD COLUMN IF NOT EXISTS metadata JSONB;

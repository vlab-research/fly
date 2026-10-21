-- A finished export can carry metadata.error from an earlier attempt that was
-- retried, and the dashboard shows it in red. The exporter now clears it when
-- a job is claimed again; this removes it from rows that finished before then.
UPDATE chatroach.export_status
SET metadata = metadata - 'error'
WHERE status = 'Finished' AND metadata ? 'error';

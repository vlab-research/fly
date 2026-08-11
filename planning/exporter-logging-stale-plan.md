# Exporter: Logging improvements + stale recovery refactor

## Changes

### 1. Add missing log lines

**`reset_for_retry`** — currently silent. Add a warning so retries are visible in logs:
```python
def reset_for_retry(cnf, export_id):
    execute(cnf, ...)
    log.warning(f"export {export_id} queued for retry")
```

**`claim_job` stale reset** — currently silent. Use `execute()` rowcount (if available) or
switch to a RETURNING query to count affected rows, then log if any were reset:
```python
reset_rows = list(query(cnf, """
    UPDATE export_status SET status = 'Requested', locked_at = NULL
    WHERE status = 'Processing' AND locked_at < NOW() - %s
    RETURNING id
""", vals=(timedelta(minutes=stuck_timeout_minutes),)))
for r in reset_rows:
    log.warning(f"reset stale export {r['id']} back to Requested")
```

### 2. Move stale recovery out of `claim_job` into the supervisor

**Why:** `claim_job` is called by every worker on every poll cycle. Stale recovery runs
4× per 5s even though it only needs to run occasionally. More importantly, if all 4 workers
are busy processing long exports, stale recovery doesn't run at all until one finishes.

**How:** Remove the stale-reset block from `claim_job`. Add a `recover_stale_jobs` call
to the supervisor loop in `app()`, which already wakes every 30s:

```python
def recover_stale_jobs(database_url, stuck_timeout_minutes):
    rows = list(query(database_url, """
        UPDATE export_status SET status = 'Requested', locked_at = NULL
        WHERE status = 'Processing' AND locked_at < NOW() - %s
        RETURNING id
    """, vals=(timedelta(minutes=stuck_timeout_minutes),)))
    for r in rows:
        log.warning(f"reset stale export {r['id']} back to Requested")

# in app():
while True:
    recover_stale_jobs(DATABASE_URL, STUCK_TIMEOUT_MINUTES)
    for i, t in enumerate(threads):
        if not t.is_alive():
            ...
    time.sleep(30)
```

`claim_job` becomes simpler — just the two-step SELECT + guarded UPDATE.

## Files

- `exporter/exporter/main.py` — only file changed
- `exporter/exporter/tests/test_main.py` — update mocks for `claim_job` (stale UPDATE removed)
- `exporter/exporter/tests/test_db_integration.py` — add test for `recover_stale_jobs`

## Test changes

- `TestClaimJob` mocks: remove the `execute` mock for the stale UPDATE (it no longer happens in `claim_job`)
- New unit test for `recover_stale_jobs`: mock `query` to return rows, assert warnings logged
- DB integration test: `recover_stale_jobs` test already exists as `test_resets_stale_processing_job_and_claims_it` but that test goes through `claim_job` — add a direct `recover_stale_jobs` test

## Deployment

No migration needed. No dashboard-server changes. Single `exporter/` deploy.

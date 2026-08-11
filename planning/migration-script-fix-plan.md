# Migration Script Fix - Implementation Plan

## Objective
Fix `devops/run-prod-migration.sh` to execute SQL migrations non-interactively against the production CockroachDB database.

## Required Reading
- `planning/migration-script-fix-findings.md` - problem analysis and solution options
- `devops/run-prod-migration.sh` - current script implementation

## Implementation Steps

### 1. Fix the kubectl run command (lines 152-157)

**Current code**:
```bash
if kubectl run -n "$NAMESPACE" -it --rm cockroach-client \
    --image=cockroachdb/cockroach:v21.2.17 \
    --restart=Never \
    --command -- ./cockroach sql --insecure \
    --host "$DB_HOST" \
    --database "$DB_NAME" < "$MIGRATION_FILE"; then
```

**New code**:
```bash
if cat "$MIGRATION_FILE" | kubectl run -n "$NAMESPACE" -i --rm cockroach-client \
    --image=cockroachdb/cockroach:v21.2.17 \
    --restart=Never \
    -- ./cockroach sql --insecure \
    --host "$DB_HOST" \
    --database "$DB_NAME"; then
```

**Changes**:
1. Remove `-t` flag (keep only `-i` for stdin)
2. Pipe SQL content with `cat "$MIGRATION_FILE" |` at the start
3. Remove `--command` flag to allow proper stdin handling
4. Remove `< "$MIGRATION_FILE"` redirect at the end

### 2. Add progress indicator (optional enhancement)
After line 148, add:
```bash
info "This may take a few moments..."
```

## Files to Modify
- `devops/run-prod-migration.sh` - lines 152-157

## Test Strategy
1. Manual test with the actual migration file from `devops/migrations/07-timeout-date-validation.sql`
2. Verify:
   - No interactive prompt appears
   - SQL executes to completion
   - Success/error messages display correctly
   - Exit codes are correct

## Acceptance Criteria
- [ ] Script executes SQL file non-interactively
- [ ] No interactive SQL prompt appears
- [ ] Migration completes or fails with clear error message
- [ ] All existing validations and safety checks remain functional
- [ ] Script returns appropriate exit codes

## Rationale
Using stdin piping (`cat | kubectl run -i`) is the correct approach because:
- It properly passes the SQL file content to the CockroachDB client
- Works with files of any size (no command-line length limits)
- Maintains streaming behavior for large migrations
- Doesn't require checking for existing pods
- Minimal changes to existing script structure

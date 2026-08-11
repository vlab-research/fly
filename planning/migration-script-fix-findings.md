# Migration Script Fix - Findings

## Problem
The script at `devops/run-prod-migration.sh` uses `kubectl run -it` with stdin redirection, but this doesn't work:

```bash
kubectl run -n "$NAMESPACE" -it --rm cockroach-client \
    --image=cockroachdb/cockroach:v21.2.17 \
    --restart=Never \
    --command -- ./cockroach sql --insecure \
    --host "$DB_HOST" \
    --database "$DB_NAME" < "$MIGRATION_FILE"
```

**Why it fails**:
- `kubectl run` with `--command --` doesn't properly handle stdin redirection
- The `< "$MIGRATION_FILE"` is processed by the local shell before kubectl starts
- Results in an interactive SQL session instead of executing the migration

## Solution Options

### Option 1: Use kubectl exec with existing pod
If there's an existing CockroachDB pod, we can exec into it and pipe SQL directly.

### Option 2: Pipe content through stdin properly
Use `cat` to pipe the SQL file content into kubectl run:
```bash
cat "$MIGRATION_FILE" | kubectl run -n "$NAMESPACE" -i --rm cockroach-client \
    --image=cockroachdb/cockroach:v21.2.17 \
    --restart=Never \
    -- ./cockroach sql --insecure \
    --host "$DB_HOST" \
    --database "$DB_NAME"
```

Key changes:
- Use `-i` (not `-it`) for stdin piping
- Pipe SQL content with `cat "$MIGRATION_FILE" |`
- Remove `--command` to allow proper stdin handling
- Remove `< "$MIGRATION_FILE"` redirect

### Option 3: Execute SQL via command argument
Pass the SQL as a command argument:
```bash
kubectl run -n "$NAMESPACE" --rm cockroach-client \
    --image=cockroachdb/cockroach:v21.2.17 \
    --restart=Never \
    -- ./cockroach sql --insecure \
    --host "$DB_HOST" \
    --database "$DB_NAME" \
    --execute "$(cat "$MIGRATION_FILE")"
```

## Recommended Approach
**Option 2** (pipe through stdin) is cleanest because:
- Handles large SQL files without command-line length limits
- Maintains streaming behavior
- Requires minimal changes
- No need to check for existing pods

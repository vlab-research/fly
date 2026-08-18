#!/usr/bin/env bash

set -euo pipefail

# Batched backfill of chatroach.messages.account_id and .platform from the
# per-shape account fields inside each row's archived `content`.
#
# Usage:
#   bash backfill-messages-account.sh <namespace>
#   bash backfill-messages-account.sh --local <port>     # test against docker
#
# Examples:
#   bash backfill-messages-account.sh vstag
#   bash backfill-messages-account.sh vprod
#   bash backfill-messages-account.sh --local 5455
#
# ---------------------------------------------------------------------------
# WHY THIS IS NOT A .sql MIGRATION
#
# 106,275,818 rows / 384.6 GiB. A .sql migration runs each statement in one
# implicit transaction, and CockroachDB v24.1 has no DO blocks (verified by the
# stream that wrote migrations 27/28), so the loop cannot live in the .sql file.
# It lives here -- still a reviewed file in the repo, still the source of truth,
# just executed by bash instead of by the SQL parser. Same reasoning and same
# shape as devops/backfill-responses-pageid.sh.
#
# WHY IT IS NOT A PREREQUISITE FOR MIGRATION 26
#
# Migrations 27 and 28 guarded against running before their backfills, because
# SET NOT NULL genuinely could not proceed on un-backfilled data. Migration 26
# has no such guard, deliberately: account_id stays NULLABLE, so the ordering is
# reversed and this script runs LAST, at leisure, after the read path already
# ships:
#
#   1. devops/migrations/26-messages-account.sql
#   2. the chatbase-postgres get() change, which TOLERATES NULL account_id
#   3. this script -- interruptible, resumable, safe to run in pieces
#
# Throughout the drain, un-backfilled rows replay exactly as they do today. See
# migration 26's section 4 for why the alternative (a strict account_id = $2
# read) would guarantee the "every existing conversation replays as empty"
# failure rather than merely risking it.
#
# ---------------------------------------------------------------------------
# WHERE THE EXTRACTION RULE LIVES -- ONE COPY, TWO CONSUMERS
#
# The account and platform expressions are NOT written in this file. They are
# read from:
#
#   devops/sql/messages-account-id-expr.sql
#   devops/sql/messages-platform-expr.sql
#
# and the same two files are evaluated by TestBackfillSQLMatchesGo in
# scribble/account_test.go against the shared cross-language fixture
# testdata/event-envelope/messenger-account-derivation.json, which also pins
# hermes' Rust and replybot's JS. So the echo-inversion rule has one
# specification, one SQL implementation, and a test that fails if the SQL and the
# Go reference implementation disagree. There is no second extractor to drift.
#
# ---------------------------------------------------------------------------
# HOW IT ITERATES -- primary-key cursor, not a NULL predicate scan
#
# The obvious form, `UPDATE ... WHERE account_id IS NULL LIMIT n` (which is what
# backfill-responses-pageid.sh does), has a performance cliff here that it does
# not have on responses. account_id IS NULL is not a usable index prefix, so each
# batch scans until it finds n matching rows. That is instant while most rows
# still match and catastrophic at the end: the final batches scan all 384 GiB to
# find nothing.
#
# So this walks the PRIMARY KEY (hsh, userid) in order with a cursor. Total work
# is one pass over the table regardless of how much is already done, and the
# cursor is printed every batch so an interrupted run resumes near where it
# stopped via START_HSH / START_USERID instead of from the beginning.
#
# `account_id IS NULL` is STILL in the update predicate, so re-running over
# already-done rows is a no-op and correctness never depends on the cursor being
# accurate. The cursor is an optimization; the predicate is the guarantee.
#
# ---------------------------------------------------------------------------
# WHY ONE LONG-LIVED POD INSTEAD OF ONE POD PER BATCH
#
# backfill-responses-pageid.sh spawns a `kubectl run` pod per batch. At 1.8M rows
# / 20k that is 91 pods and the ~8s startup is noise. Here it would be ~5,300
# pods and roughly 12 hours of pure pod startup. So the loop is shipped into a
# SINGLE client pod over stdin and runs there, calling the local `cockroach sql`
# client thousands of times.
#
# Consequence to know about: if that pod is evicted the run stops. That is safe
# (every batch is its own transaction and the predicate makes re-runs no-ops) but
# it is not automatic -- re-invoke with the last printed cursor.
#
# Batch size stays small for the same reason 28 chose 20k: an UPDATE is one
# transaction, rows here average ~430 bytes across ~1.3 KB of primary-index row,
# and 20k rows is already ~10-25 MB of write intents. Raising it to shorten the
# run is the wrong lever -- it trades a long safe run for a transaction that may
# not commit at all.

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

DB_HOST="gbv-cockroachdb-public"
DB_NAME="chatroach"
PROD_NAMESPACE="vprod"
CRDB_IMAGE="cockroachdb/cockroach:v24.1.28"

BATCH_SIZE="${BATCH_SIZE:-20000}"
MAX_BATCHES="${MAX_BATCHES:-20000}"
START_HSH="${START_HSH:-}"
START_USERID="${START_USERID:-}"

error()   { echo -e "${RED}ERROR: $1${NC}" >&2; }
warning() { echo -e "${YELLOW}WARNING: $1${NC}" >&2; }
info()    { echo -e "${CYAN}INFO: $1${NC}"; }
success() { echo -e "${GREEN}SUCCESS: $1${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCT_EXPR_FILE="$SCRIPT_DIR/sql/messages-account-id-expr.sql"
PLAT_EXPR_FILE="$SCRIPT_DIR/sql/messages-platform-expr.sql"

usage() {
    cat << EOF
Usage: $(basename "$0") <namespace>
       $(basename "$0") --local <port>

Backfill chatroach.messages.account_id and .platform from each row's archived
\`content\`, in bounded batches, walking the primary key with a cursor.

Arguments:
    namespace       Kubernetes namespace (e.g. vstag, vprod)
    --local <port>  Run against a CockroachDB on localhost:<port> instead.
                    Used by the tests and for rehearsing on a small database.

Environment:
    BATCH_SIZE      Rows per transaction (default 20000). See the header before
                    raising this.
    MAX_BATCHES     Safety stop (default 20000)
    START_HSH       Resume cursor: hsh of the last completed batch
    START_USERID    Resume cursor: userid of the last completed batch

Options:
    -h, --help      Show this help message

IMPORTANT: Running against $PROD_NAMESPACE targets the PRODUCTION database and
           requires typing the namespace to confirm.

EOF
    exit 0
}

if [[ "${1:-}" == "-h" ]] || [[ "${1:-}" == "--help" ]]; then
    usage
fi

if [[ $# -lt 1 ]]; then
    error "Expected at least 1 argument, got $#"
    echo ""
    usage
fi

LOCAL_MODE=false
LOCAL_PORT=""
NAMESPACE=""

if [[ "$1" == "--local" ]]; then
    if [[ $# -ne 2 ]]; then
        error "--local requires a port"
        exit 1
    fi
    LOCAL_MODE=true
    LOCAL_PORT="$2"
else
    if [[ $# -ne 1 ]]; then
        error "Expected 1 argument, got $#"
        exit 1
    fi
    NAMESPACE="$1"
fi

for f in "$ACCT_EXPR_FILE" "$PLAT_EXPR_FILE"; do
    if [[ ! -f "$f" ]]; then
        error "Missing SQL expression file: $f"
        error "This script does not contain the extraction rule -- see the header."
        exit 1
    fi
done

# Strip whole-line SQL comments before embedding, so a 40-line licence header
# does not end up in every log line. The expression files are required to keep
# comments on their own lines for exactly this reason -- it is stated in their
# headers. A trailing `--` comment on an expression line would comment out the
# rest of that line and silently truncate the expression, so this is the one
# formatting rule those files have to obey.
strip_sql_comments() {
    sed -e 's/^[[:space:]]*--.*$//' "$1" | grep -v '^[[:space:]]*$'
}

ACCT_EXPR="$(strip_sql_comments "$ACCT_EXPR_FILE")"
PLAT_EXPR="$(strip_sql_comments "$PLAT_EXPR_FILE")"

if [[ -z "$ACCT_EXPR" ]] || [[ -z "$PLAT_EXPR" ]]; then
    error "An expression file reduced to nothing after comment stripping."
    exit 1
fi

if [[ "$LOCAL_MODE" == false ]]; then
    if ! command -v kubectl &> /dev/null; then
        error "kubectl is not installed or not in PATH"
        exit 1
    fi
    if ! kubectl cluster-info &> /dev/null; then
        error "Cannot connect to Kubernetes cluster. Check your kubectl configuration."
        exit 1
    fi
    if ! kubectl get namespace "$NAMESPACE" &> /dev/null; then
        error "Namespace '$NAMESPACE' does not exist in the current cluster"
        exit 1
    fi
fi

echo ""
echo "=========================================="
echo "  MESSAGES ACCOUNT / PLATFORM BACKFILL"
echo "=========================================="
echo ""
if [[ "$LOCAL_MODE" == true ]]; then
    info "Target:         LOCAL localhost:$LOCAL_PORT"
else
    info "Target Cluster: $(kubectl config current-context)"
    info "Namespace:      $NAMESPACE"
    info "Database:       $DB_HOST/$DB_NAME"
fi
info "Batch size:     $BATCH_SIZE rows per transaction"
info "Rule:           devops/sql/messages-{account-id,platform}-expr.sql"
if [[ -n "$START_HSH" ]]; then
    info "Resuming from:  hsh=$START_HSH userid=$START_USERID"
fi
echo ""
echo "=========================================="
echo ""

if [[ "$LOCAL_MODE" == false ]]; then
    if [[ "$NAMESPACE" == "$PROD_NAMESPACE" ]]; then
        warning "You are about to modify the PRODUCTION database!"
        warning "This walks all 106M rows of a 384 GiB table. Expect a long run."
        echo ""
        read -r -p "Type the namespace ($PROD_NAMESPACE) to proceed: " confirmation
        if [[ "$confirmation" != "$PROD_NAMESPACE" ]]; then
            info "Backfill cancelled by user."
            exit 0
        fi
    else
        read -r -p "Proceed against '$NAMESPACE'? (yes/no): " confirmation
        case "$confirmation" in
            yes|YES|y|Y) ;;
            *) info "Backfill cancelled by user."; exit 0 ;;
        esac
    fi
fi

# ---------------------------------------------------------------------------
# The loop. Runs inside ONE client pod (or locally in --local mode), so the
# thousands of statements it issues do not each pay pod startup.
#
# Per batch, two statements:
#   1. find the batch's upper boundary by walking the primary key
#   2. UPDATE strictly within (cursor, boundary]
#
# Bounding both sides is what keeps each transaction's size predictable. The
# update predicate also carries `account_id IS NULL`, so a re-run is a no-op, and
# `(<acct>) IS NOT NULL`, so rows whose account is NOT derivable are never
# selected. That last clause is what makes termination well defined: without it,
# a row that legitimately extracts to NULL would be "updated" to NULL forever and
# the loop would never finish.
# ---------------------------------------------------------------------------

# Connection flags are resolved BEFORE the heredoc so they expand into it
# naturally. Building the program first and string-substituting afterwards looks
# tidier and is a trap: the heredoc is unquoted, so an un-escaped $SQL_CONN would
# expand to empty at build time and there would be nothing left to substitute.
if [[ "$LOCAL_MODE" == true ]]; then
    SQL_CONN="--host localhost --port $LOCAL_PORT"
else
    SQL_CONN="--host $DB_HOST"
fi

LOOP_PROGRAM=$(cat <<PROGRAM
set -uo pipefail

BATCH_SIZE=$BATCH_SIZE
MAX_BATCHES=$MAX_BATCHES
CUR_HSH='$START_HSH'
CUR_USERID='$START_USERID'

sql() {
  ./cockroach sql --insecure $SQL_CONN --database $DB_NAME --format=csv -e "\$1"
}

total=0
batch=0
while [ "\$batch" -lt "\$MAX_BATCHES" ]; do
  batch=\$(( batch + 1 ))

  # Cleared every iteration. Left set, the final batch -- which has no boundary
  # because it runs to the end of the table -- would print the PREVIOUS batch's
  # boundary as its cursor. Stale is safe (the cursor only ever lags real
  # progress, and \`account_id IS NULL\` makes a re-scan a no-op) but a resume
  # cursor that silently means something other than what it says is exactly the
  # kind of thing that gets trusted at 3am.
  B_HSH=""
  B_USERID=""

  if [ -z "\$CUR_HSH" ]; then
    LOWER=""
  else
    LOWER="WHERE (hsh, userid) > (\$CUR_HSH, '\$CUR_USERID')"
  fi

  # Upper boundary: the key BATCH_SIZE rows ahead. Empty means this is the last
  # batch and it runs to the end of the table.
  BOUND=\$(sql "SELECT hsh::STRING || '|' || userid FROM chatroach.messages \$LOWER ORDER BY hsh, userid LIMIT 1 OFFSET \$BATCH_SIZE;" 2>&1 | sed -n '2p')

  if echo "\$BOUND" | grep -qi 'error'; then
    echo "FATAL: boundary query failed: \$BOUND"
    exit 1
  fi

  if [ -n "\$BOUND" ]; then
    B_HSH=\$(echo "\$BOUND" | cut -d'|' -f1)
    # cut -f2- rather than -f2 so a userid containing '|' survives, and the
    # apostrophe is doubled because it is interpolated into a SQL literal.
    # states.pageid is known to hold values like '107718334922830 with a leading
    # apostrophe (plan §2.3), so a userid doing the same is not hypothetical.
    B_USERID=\$(echo "\$BOUND" | cut -d'|' -f2- | sed "s/'/''/g")
    UPPER="AND (hsh, userid) <= (\$B_HSH, '\$B_USERID')"
  else
    UPPER=""
  fi

  if [ -z "\$CUR_HSH" ]; then
    RANGE="WHERE true \$UPPER"
  else
    RANGE="WHERE (hsh, userid) > (\$CUR_HSH, '\$CUR_USERID') \$UPPER"
  fi

  OUT=\$(sql "UPDATE chatroach.messages SET account_id = ($ACCT_EXPR), platform = ($PLAT_EXPR) \$RANGE AND account_id IS NULL AND json_valid(content) AND ($ACCT_EXPR) IS NOT NULL;" 2>&1)

  if echo "\$OUT" | grep -qi 'error'; then
    echo "FATAL: update failed at cursor hsh=\$CUR_HSH userid=\$CUR_USERID"
    echo "\$OUT"
    echo "Re-run with: START_HSH=\$CUR_HSH START_USERID='\$CUR_USERID'"
    exit 1
  fi

  UPDATED=\$(echo "\$OUT" | grep -oE 'UPDATE [0-9]+' | tail -n1 | awk '{print \$2}')
  UPDATED=\${UPDATED:-0}
  total=\$(( total + UPDATED ))

  echo "batch \$batch: \$UPDATED rows (total \$total) cursor hsh=\${B_HSH:-END} userid=\${B_USERID:-END}"

  if [ -z "\$BOUND" ]; then
    echo "DONE: reached the end of the table. \$total rows updated across \$batch batches."
    exit 0
  fi

  CUR_HSH="\$B_HSH"
  CUR_USERID="\$B_USERID"
done

echo "STOPPED: hit MAX_BATCHES=\$MAX_BATCHES. \$total rows updated."
echo "Re-run with: START_HSH=\$CUR_HSH START_USERID='\$CUR_USERID'"
exit 2
PROGRAM
)

set +e
if [[ "$LOCAL_MODE" == true ]]; then
    info "Running loop locally via docker $CRDB_IMAGE..."
    echo "$LOOP_PROGRAM" | docker run -i --rm --net=host --entrypoint bash "$CRDB_IMAGE" -s
    rc=$?
else
    info "Starting single client pod for the whole run..."
    echo "$LOOP_PROGRAM" | kubectl run -n "$NAMESPACE" -i --rm --quiet \
        "backfill-messages-$$-${RANDOM}" \
        --image="$CRDB_IMAGE" \
        --restart=Never \
        --pod-running-timeout=5m \
        --command -- bash -s
    rc=$?
fi
set -e

echo ""
if [[ $rc -eq 0 ]]; then
    success "Backfill complete."
    echo ""
    info "Removal gate for the NULL-tolerant branch in chatbase-postgres get()."
    info "Rows still attributable but not yet attributed -- must be 0."
    info "This is a full scan of 384 GiB. Run it deliberately."
    echo ""
    echo "  SELECT count(*) FROM chatroach.messages"
    echo "   WHERE account_id IS NULL AND json_valid(content)"
    echo "     AND (<devops/sql/messages-account-id-expr.sql>) IS NOT NULL;"
    echo ""
    info "A plain count of NULL account_id will NEVER reach zero, and should not:"
    info "~0.0015% of rows are synthetic events carrying no account at all"
    info "(3 in a uniform 200,000-row sample), plus any malformed content."
    info "Those are permanently unattributable. NULL is the honest answer."
elif [[ $rc -eq 2 ]]; then
    warning "Stopped at MAX_BATCHES. Re-run with the printed cursor to continue."
else
    error "Backfill did not complete (exit $rc). Re-run with the printed cursor."
fi

exit $rc

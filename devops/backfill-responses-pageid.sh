#!/usr/bin/env bash

set -euo pipefail

# Batched backfill of chatroach.responses.pageid, NULL -> '' (account unknown).
#
# Usage: bash backfill-responses-pageid.sh <namespace>
#
# Example:
#   bash backfill-responses-pageid.sh vstag
#   bash backfill-responses-pageid.sh vprod
#
# WHY THIS IS NOT A .sql MIGRATION
#
# devops/migrations/28a-responses-account-scoped-key.sql needs pageid to be NOT
# NULL so it can enter the primary key -- a conversation is (platform,
# account_id, user_id), and an identity component cannot be nullable.
# CockroachDB rejects a nullable column in a primary key outright (SQLSTATE
# 42P15).
#
# Production has ~1.82M NULL-pageid rows out of ~17.8M. A .sql migration runs
# each statement in one implicit transaction, and a 1.8M-row UPDATE of rows
# carrying `response` text plus a `metadata` JSONB is far past what a single
# CockroachDB transaction should carry. CockroachDB v24.1 has no DO blocks
# (verified: `DO $$ ... $$` is a syntax error), so the loop cannot live in the
# .sql file. It lives here instead -- still a reviewed file in the repo, still
# the source of truth, just executed by bash rather than by the SQL parser.
#
# The rows are frozen legacy data: max(timestamp) among NULL-pageid rows is
# 2020-09-06 and every month for the last ten months has zero. This is a
# one-time historical cleanup, not a recurring job.
#
# Idempotent and interruptible. Re-running after a partial run resumes; running
# it once the table is clean does one bounded scan and exits.

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

DB_HOST="gbv-cockroachdb-public"
DB_NAME="chatroach"
PROD_NAMESPACE="vprod"
BATCH_SIZE="${BATCH_SIZE:-20000}"
MAX_BATCHES="${MAX_BATCHES:-200}"

error()   { echo -e "${RED}ERROR: $1${NC}" >&2; }
warning() { echo -e "${YELLOW}WARNING: $1${NC}" >&2; }
info()    { echo -e "${CYAN}INFO: $1${NC}"; }
success() { echo -e "${GREEN}SUCCESS: $1${NC}"; }

usage() {
    cat << EOF
Usage: $(basename "$0") <namespace>

Backfill chatroach.responses.pageid from NULL to '' in bounded batches, so that
devops/migrations/28a-responses-account-scoped-key.sql can make the column NOT
NULL and fold it into the primary key.

Arguments:
    namespace       Kubernetes namespace (e.g. vstag, vprod)

Environment:
    BATCH_SIZE      Rows per transaction (default 20000)
    MAX_BATCHES     Safety stop (default 200)

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

if [[ $# -ne 1 ]]; then
    error "Expected 1 argument, got $#"
    echo ""
    usage
fi

NAMESPACE="$1"

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

run_sql() {
    kubectl run -n "$NAMESPACE" -i --rm --quiet "backfill-client-$$-${RANDOM}" \
        --image=cockroachdb/cockroach:v24.1.28 \
        --restart=Never \
        --pod-running-timeout=5m \
        --command -- ./cockroach sql --insecure \
        --host "$DB_HOST" \
        --database "$DB_NAME" \
        --format=csv \
        -e "$1"
}

echo ""
echo "=========================================="
echo "  RESPONSES PAGEID BACKFILL"
echo "=========================================="
echo ""
info "Target Cluster: $(kubectl config current-context)"
info "Namespace:      $NAMESPACE"
info "Database:       $DB_HOST/$DB_NAME"
info "Batch size:     $BATCH_SIZE rows per transaction"
info "Statement:      UPDATE chatroach.responses SET pageid = '' WHERE pageid IS NULL LIMIT $BATCH_SIZE"
echo ""
echo "=========================================="
echo ""

if [[ "$NAMESPACE" == "$PROD_NAMESPACE" ]]; then
    warning "You are about to modify the PRODUCTION database!"
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

info "Confirmed. Backfilling in batches of $BATCH_SIZE..."
echo ""

total=0
for (( batch = 1; batch <= MAX_BATCHES; batch++ )); do
    # CockroachDB supports LIMIT on UPDATE, which is what bounds each transaction.
    out="$(run_sql "UPDATE chatroach.responses SET pageid = '' WHERE pageid IS NULL LIMIT ${BATCH_SIZE};")"
    updated="$(echo "$out" | grep -oE 'UPDATE [0-9]+' | tail -n1 | awk '{print $2}')"
    updated="${updated:-0}"
    total=$(( total + updated ))

    info "batch ${batch}: ${updated} rows (running total ${total})"

    if [[ "$updated" -eq 0 ]]; then
        success "Backfill complete. ${total} rows updated across $(( batch - 1 )) batches."
        echo ""
        info "Next: bash devops/run-migration.sh ${NAMESPACE} migrations/28a-responses-account-scoped-key.sql (then deploy scribble, then 28b)"
        exit 0
    fi
done

error "Hit MAX_BATCHES=${MAX_BATCHES} with rows still remaining (${total} updated so far)."
error "Re-run to continue, or raise MAX_BATCHES."
exit 1

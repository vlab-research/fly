#!/usr/bin/env bash

set -euo pipefail

# Run a SQL migration against a CockroachDB database in a given namespace.
#
# Usage: bash run-migration.sh <namespace> <migration-file.sql>
#
# Example:
#   bash run-migration.sh vstag migrations/16-export-db-polling.sql
#   bash run-migration.sh vprod migrations/17-export-metadata.sql
#
# Production runs require typing the namespace to confirm.

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

DB_HOST="gbv-cockroachdb-public"
DB_NAME="chatroach"
PROD_NAMESPACE="vprod"

error()   { echo -e "${RED}ERROR: $1${NC}" >&2; }
warning() { echo -e "${YELLOW}WARNING: $1${NC}" >&2; }
info()    { echo -e "${CYAN}INFO: $1${NC}"; }
success() { echo -e "${GREEN}SUCCESS: $1${NC}"; }

usage() {
    cat << EOF
Usage: $(basename "$0") <namespace> <migration-file.sql>

Run a SQL migration against the CockroachDB database in <namespace>.

Arguments:
    namespace             Kubernetes namespace (e.g. vstag, vprod)
    migration-file.sql    Path to the SQL migration file to execute

Options:
    -h, --help           Show this help message

Example:
    $(basename "$0") vstag migrations/16-export-db-polling.sql

IMPORTANT: Running against $PROD_NAMESPACE targets the PRODUCTION database and
           requires typing the namespace to confirm.

EOF
    exit 0
}

if [[ "${1:-}" == "-h" ]] || [[ "${1:-}" == "--help" ]]; then
    usage
fi

if [[ $# -ne 2 ]]; then
    error "Expected 2 arguments, got $#"
    echo ""
    usage
fi

NAMESPACE="$1"
MIGRATION_FILE="$2"

if [[ ! -f "$MIGRATION_FILE" ]]; then
    error "Migration file does not exist: $MIGRATION_FILE"
    exit 1
fi

if [[ ! -s "$MIGRATION_FILE" ]]; then
    error "Migration file is empty: $MIGRATION_FILE"
    exit 1
fi

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

echo ""
echo "=========================================="
echo "  MIGRATION CONFIRMATION"
echo "=========================================="
echo ""
info "Migration File: $(basename "$MIGRATION_FILE")"
info "Full Path:      $MIGRATION_FILE"
info "Target Cluster: $(kubectl config current-context)"
info "Namespace:      $NAMESPACE"
info "Database Host:  $DB_HOST"
info "Database Name:  $DB_NAME"
echo ""
echo "------------------------------------------"
echo "SQL Preview (first 20 lines):"
echo "------------------------------------------"
head -n 20 "$MIGRATION_FILE"
echo ""
if [[ $(wc -l < "$MIGRATION_FILE") -gt 20 ]]; then
    echo "... (file has $(wc -l < "$MIGRATION_FILE") lines total)"
    echo ""
fi
echo "=========================================="
echo ""

if [[ "$NAMESPACE" == "$PROD_NAMESPACE" ]]; then
    warning "You are about to run this migration against the PRODUCTION database!"
    echo ""
    read -r -p "Type the namespace ($PROD_NAMESPACE) to proceed: " confirmation
    if [[ "$confirmation" != "$PROD_NAMESPACE" ]]; then
        info "Migration cancelled by user."
        exit 0
    fi
else
    read -r -p "Proceed against '$NAMESPACE'? (yes/no): " confirmation
    case "$confirmation" in
        yes|YES|y|Y) ;;
        *) info "Migration cancelled by user."; exit 0 ;;
    esac
fi

info "Confirmed. Executing migration..."
echo ""

if kubectl run -n "$NAMESPACE" -i --rm "migration-client-$$" \
    --image=cockroachdb/cockroach:v24.1.28 \
    --restart=Never \
    --pod-running-timeout=5m \
    --command -- ./cockroach sql --insecure \
    --host "$DB_HOST" \
    --database "$DB_NAME" < "$MIGRATION_FILE"; then
    echo ""
    success "Migration completed successfully!"
else
    exit_code=$?
    echo ""
    error "Migration failed with exit code $exit_code"
    exit "$exit_code"
fi

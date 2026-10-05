#!/usr/bin/env bash
#
# Run a SQL migration against the CockroachDB database in a namespace, as an
# in-cluster Kubernetes Job.
#
# Usage: devops/run-migration.sh <namespace> <migration-file.sql>
#
#   devops/run-migration.sh vstag devops/migrations/33-states-last-inbound.sql
#   devops/run-migration.sh vprod devops/migrations/prod/15-chatroach-scheduled-backup.sql
#
# The SQL is shipped in a ConfigMap and executed by `cockroach sql --file` in a
# Job, so it keeps running if this terminal disconnects, and the Job's status
# (not a streamed connection) decides success. The file runs as one session and
# stops at its first error. The Job and its logs are kept for 7 days.
#
# vprod requires typing the namespace to confirm. The confirmation is read from
# stdin, so `echo vprod | devops/run-migration.sh vprod <file>` works unattended.
# See documentation/migrations.md.

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

DB_STATEFULSET="gbv-cockroachdb"
DB_HOST="gbv-cockroachdb-public"
DB_NAME="chatroach"
PROD_NAMESPACE="vprod"
KEEP_SECONDS=604800
SCHEDULE_TIMEOUT_SECONDS=300

error()   { echo -e "${RED}ERROR: $1${NC}" >&2; }
warning() { echo -e "${YELLOW}WARNING: $1${NC}" >&2; }
info()    { echo -e "${CYAN}INFO: $1${NC}"; }
success() { echo -e "${GREEN}SUCCESS: $1${NC}"; }

usage() {
    sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && usage 0
if [[ $# -ne 2 ]]; then
    error "Expected 2 arguments, got $#"
    usage 1
fi

NAMESPACE="$1"
MIGRATION_FILE="$2"

[[ -f "$MIGRATION_FILE" ]] || { error "Migration file does not exist: $MIGRATION_FILE"; exit 1; }
[[ -s "$MIGRATION_FILE" ]] || { error "Migration file is empty: $MIGRATION_FILE"; exit 1; }
command -v kubectl &> /dev/null || { error "kubectl is not installed or not in PATH"; exit 1; }
kubectl get namespace "$NAMESPACE" &> /dev/null \
    || { error "Namespace '$NAMESPACE' not found in context $(kubectl config current-context)"; exit 1; }

# The client must match the server's version, so take the image from the live
# database rather than pinning one here.
DB_IMAGE=$(kubectl -n "$NAMESPACE" get statefulset "$DB_STATEFULSET" \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="db")].image}' 2>/dev/null || true)
[[ -n "$DB_IMAGE" ]] \
    || { error "Could not read the image of statefulset/$DB_STATEFULSET in $NAMESPACE"; exit 1; }

BASE=$(basename "$MIGRATION_FILE" .sql | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | cut -c1-40)
JOB="migration-${BASE%-}-$(date -u +%Y%m%d%H%M%S)"

echo ""
echo "=========================================="
echo "  MIGRATION"
echo "=========================================="
info "File:      $MIGRATION_FILE ($(wc -l < "$MIGRATION_FILE") lines)"
info "Context:   $(kubectl config current-context)"
info "Namespace: $NAMESPACE"
info "Database:  $DB_NAME on $DB_HOST"
info "Client:    $DB_IMAGE"
info "Job:       $JOB"
echo "=========================================="
echo ""

if [[ "$NAMESPACE" == "$PROD_NAMESPACE" ]]; then
    warning "This runs against the PRODUCTION database."
    read -r -p "Type the namespace ($PROD_NAMESPACE) to proceed: " confirmation || true
    [[ "${confirmation:-}" == "$PROD_NAMESPACE" ]] || { info "Cancelled."; exit 1; }
else
    read -r -p "Proceed against '$NAMESPACE'? (yes/no): " confirmation || true
    case "${confirmation:-}" in
        yes|YES|y|Y) ;;
        *) info "Cancelled."; exit 1 ;;
    esac
fi

kubectl -n "$NAMESPACE" apply -f - > /dev/null <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: $JOB
  labels:
    app.kubernetes.io/name: migration-runner
  annotations:
    vlab.digital/migration-file: "$MIGRATION_FILE"
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: $KEEP_SECONDS
  template:
    metadata:
      labels:
        app.kubernetes.io/name: migration-runner
    spec:
      restartPolicy: Never
      containers:
        - name: sql
          image: $DB_IMAGE
          command:
            - /cockroach/cockroach
            - sql
            - --insecure
            - --host=$DB_HOST
            - --database=$DB_NAME
            - --echo-sql
            - --file=/migration/migration.sql
          env:
            - name: HOME
              value: /tmp
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          volumeMounts:
            - name: migration
              mountPath: /migration
              readOnly: true
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: migration
          configMap:
            name: $JOB
        - name: tmp
          emptyDir: {}
EOF

# The ConfigMap is owned by the Job, so it is deleted with it. The pod waits
# for the mount until the ConfigMap exists.
JOB_UID=$(kubectl -n "$NAMESPACE" get job "$JOB" -o jsonpath='{.metadata.uid}')
kubectl -n "$NAMESPACE" create configmap "$JOB" \
    --from-file=migration.sql="$MIGRATION_FILE" --dry-run=client -o json \
  | python3 -c '
import json, sys
cm = json.load(sys.stdin)
cm["metadata"]["labels"] = {"app.kubernetes.io/name": "migration-runner"}
cm["metadata"]["ownerReferences"] = [{
    "apiVersion": "batch/v1", "kind": "Job",
    "name": sys.argv[1], "uid": sys.argv[2]}]
json.dump(cm, sys.stdout)' "$JOB" "$JOB_UID" \
  | kubectl -n "$NAMESPACE" apply -f - > /dev/null

follow_hint() {
    echo ""
    warning "Stopped watching. The migration keeps running in the cluster."
    info "Follow: kubectl -n $NAMESPACE logs -f job/$JOB"
    info "Status: kubectl -n $NAMESPACE get job $JOB"
    exit 130
}
trap follow_hint INT TERM

job_state() {
    kubectl -n "$NAMESPACE" get job "$JOB" -o jsonpath='{range .status.conditions[?(@.status=="True")]}{.type}{"\n"}{end}' \
        | grep -E '^(Complete|Failed)$' | head -1 || true
}

info "Waiting for the migration pod to start..."
waited=0
while :; do
    phase=$(kubectl -n "$NAMESPACE" get pods -l job-name="$JOB" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || true)
    [[ "$phase" == "Running" || "$phase" == "Succeeded" || "$phase" == "Failed" ]] && break
    if (( waited >= SCHEDULE_TIMEOUT_SECONDS )); then
        error "Pod did not start within ${SCHEDULE_TIMEOUT_SECONDS}s. Nothing has run against the database."
        kubectl -n "$NAMESPACE" describe pods -l job-name="$JOB" | tail -20 >&2
        kubectl -n "$NAMESPACE" delete job "$JOB" --wait=false > /dev/null
        exit 1
    fi
    sleep 2
    waited=$((waited + 2))
done

echo "------------------------------------------"
kubectl -n "$NAMESPACE" logs -f "job/$JOB" || true
echo "------------------------------------------"

# A dropped log stream says nothing about the migration; the Job status does.
# The Job controller records completion a few seconds after the pod exits.
state=$(job_state)
for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -n "$state" ]] && break
    sleep 3
    state=$(job_state)
done
if [[ -z "$state" ]]; then
    warning "Log stream ended before the Job finished; waiting on the Job itself."
    while [[ -z "$state" ]]; do
        sleep 5
        state=$(job_state)
    done
    info "Full log: kubectl -n $NAMESPACE logs job/$JOB"
fi

if [[ "$state" == "Complete" ]]; then
    success "Migration completed: $MIGRATION_FILE"
    info "Job $JOB is kept for 7 days."
    exit 0
fi

error "Migration FAILED: $MIGRATION_FILE"
error "Statements before the failing one have already committed unless the file wraps them in a transaction."
info "Log: kubectl -n $NAMESPACE logs job/$JOB"
exit 1

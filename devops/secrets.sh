#!/usr/bin/env bash

set -euo pipefail

# Apply a Kubernetes secret from a gitignored .env file.
#
# The .env file is the source of truth. Never edit a secret in the cluster
# directly (kubectl patch/edit) -- the change is invisible, unreviewable, and
# lost on the next apply. Edit the .env file, then re-run this script.
#
# Usage: bash secrets.sh <namespace> <secret-name> <env-file>
#
# Example:
#   bash secrets.sh vstag exporter ../exporter/.env-staging
#
# See documentation/secrets.md for the full convention.

usage() {
    cat << EOF
Usage: $(basename "$0") <namespace> <secret-name> <env-file>

Apply a Kubernetes secret from a .env file (KEY=VALUE per line).
The apply is idempotent -- it creates the secret or updates it in place.

Example:
    $(basename "$0") vstag exporter ../exporter/.env-staging

EOF
    exit 0
}

if [[ "${1:-}" == "-h" ]] || [[ "${1:-}" == "--help" ]] || [[ $# -ne 3 ]]; then
    usage
fi

NAMESPACE=$1
SECRET=$2
ENV_FILE=$3

if [[ ! -r "$ENV_FILE" ]]; then
    echo "ERROR: env file not readable: $ENV_FILE" >&2
    exit 1
fi

# Check values only -- comment lines legitimately mention the placeholder token.
if grep -v '^[[:space:]]*#' "$ENV_FILE" | grep -q '__FILL_'; then
    echo "ERROR: $ENV_FILE still contains __FILL_...__ placeholders:" >&2
    grep -v '^[[:space:]]*#' "$ENV_FILE" | grep -n '__FILL_' | cut -d= -f1 >&2
    echo "       Populate them before applying (see the header of that file)." >&2
    exit 1
fi

kubectl -n "$NAMESPACE" create secret generic "$SECRET" \
    --from-env-file="$ENV_FILE" --dry-run=client -o yaml | kubectl apply -f -

echo "Applied secret '$SECRET' in namespace '$NAMESPACE' from $ENV_FILE"
echo "NOTE: pods do not pick up envFrom/secret changes automatically -- restart them:"
echo "  kubectl rollout restart deployment/<name> -n $NAMESPACE"

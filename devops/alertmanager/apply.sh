#!/usr/bin/env bash
# Reproduce / update the LIVE AlertManager config (Slack-only two-channel
# routing). Injects the two Slack webhooks into alertmanager.yaml and updates the
# `alertmanager` secret; the prometheus-operator regenerates the mounted config
# and AlertManager hot-reloads. No helm upgrade needed.
#
# Prereqs: devops/alertmanager/secret.env (gitignored) — copy secret.env.template
# and fill in the two real incoming-webhook URLs.
set -euo pipefail
cd "$(dirname "$0")"

[ -f secret.env ] || { echo "ERROR: missing secret.env (copy secret.env.template and fill it in)"; exit 1; }
set -a; . ./secret.env; set +a
: "${SLACK_WEBHOOK_WARNING:?set in secret.env}"
: "${SLACK_WEBHOOK_CRITICAL:?set in secret.env}"

# Back up whatever is live now (contains real webhooks -> gitignored).
kubectl -n monitoring get secret alertmanager -o jsonpath='{.data.alertmanager\.yaml}' \
  | base64 -d > alertmanager.live-backup.yaml 2>/dev/null || true

# Render config with real webhooks into a temp file.
RENDER="$(mktemp -d)/alertmanager.yaml"
trap 'rm -rf "$(dirname "$RENDER")"' EXIT
sed -e "s#\${SLACK_WEBHOOK_WARNING}#${SLACK_WEBHOOK_WARNING}#" \
    -e "s#\${SLACK_WEBHOOK_CRITICAL}#${SLACK_WEBHOOK_CRITICAL}#" alertmanager.yaml > "$RENDER"

# Validate before touching the live config (a bad config would break ALL alerting).
docker run --rm --entrypoint amtool -v "$(dirname "$RENDER"):/cfg" \
  prom/alertmanager:v0.24.0 check-config /cfg/alertmanager.yaml

# Apply (operator regenerates the mounted secret; AM hot-reloads within ~1m).
kubectl create secret generic alertmanager -n monitoring \
  --from-file=alertmanager.yaml="$RENDER" --dry-run=client -o yaml | kubectl apply -f -

echo "Applied. Verify: kubectl -n monitoring logs \$(kubectl -n monitoring get pod -l app.kubernetes.io/name=alertmanager -o name | head -1) -c alertmanager | grep -i reload"
echo "Rollback: kubectl create secret generic alertmanager -n monitoring --from-file=alertmanager.yaml=alertmanager.live-backup.yaml --dry-run=client -o yaml | kubectl apply -f -"

#!/usr/bin/env bash
#
# Hand thread control back to Fly for a stuck smoke-test user, via smoke-echo's
# /admin/passback endpoint. smoke-echo is multi-page, so a PAGE ID is required —
# it selects which page's token to use and which Fly app to hand back to.
#
# Usage:
#   ./scripts/passback.sh <messenger-user-id> <page-id> [target-app-id]
#
# Examples:
#   # Hand control back to that page's default Fly app
#   ./scripts/passback.sh 1972130092884542 935593143497601
#
#   # Override the target app id explicitly
#   ./scripts/passback.sh 1989430067808669 1855355231229529 699455733740842
#
# Env:
#   SMOKE_ECHO_ENDPOINT  override the endpoint (default: production URL)
set -euo pipefail

USER_ID="${1:-}"
PAGE_ID="${2:-}"
TARGET_APP_ID="${3:-}"

if [[ -z "$USER_ID" || -z "$PAGE_ID" ]]; then
  echo "usage: $0 <messenger-user-id> <page-id> [target-app-id]" >&2
  exit 2
fi

ENDPOINT="${SMOKE_ECHO_ENDPOINT:-https://fly-smoke-echo.vlab.digital/admin/passback}"

payload="{\"userId\":\"${USER_ID}\",\"pageId\":\"${PAGE_ID}\""
if [[ -n "$TARGET_APP_ID" ]]; then
  payload="${payload},\"targetAppId\":\"${TARGET_APP_ID}\""
fi
payload="${payload}}"

echo "POST ${ENDPOINT}"
echo "  ${payload}"
curl -sS -X POST "$ENDPOINT" -H 'content-type: application/json' -d "$payload"
echo

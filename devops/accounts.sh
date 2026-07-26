#!/usr/bin/env bash

set -euo pipefail

# Convenience wrapper for the `gbv-bot-envs` secret.
# See documentation/secrets.md; use secrets.sh directly for any other secret.
#
# Usage: bash accounts.sh <namespace> [env-file]

NAMESPACE=$1
ENV_FILE=${2:-../replybot/.env}

exec bash "$(dirname "$0")/secrets.sh" "$NAMESPACE" gbv-bot-envs "$ENV_FILE"

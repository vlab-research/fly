#!/usr/bin/env bash
#
# Clear replybot's cached conversation state for specific participants.
#
# WHY THIS EXISTS
#
# Replybot treats Redis as the runtime source of truth for state
# (replybot/lib/typewheels/statestore.js). getState() returns the cached value
# and only replays the Kafka event log on a cache MISS. updateState() writes
# back with SETEX, so every processed event refreshes the 24h TTL.
#
# The consequence: when a replybot bug corrupts derived state, deploying the fix
# does NOT heal existing participants. Their corrupt state is served from cache
# forever, and any retry mechanism that keeps touching them keeps the TTL alive.
# The only way to re-derive state under the fixed code is to force a cache miss.
#
# First needed for VIR-18: the VIR-19 referral regression misattributed live
# participants to FALLBACK_FORM, and Dean's retry sweep re-errored them every 30
# minutes off the cached state instead of replaying the log.
#
# SAFETY
#
# Deleting these keys is non-destructive. State is derived data -- the Kafka
# event log is the durable record, and a cache miss simply recomputes state from
# it. The worst case of a wrong key is one extra replay.
#
# Nothing is sent to participants by this script. Clearing a key is inert until
# some later event (a Dean retry, or the participant writing in) triggers
# processing, at which point replybot replays the log and continues normally.
#
# USAGE
#
#   devops/clear-state-cache.sh <namespace> <userid-file>   # one userid per line
#   devops/clear-state-cache.sh <namespace> --stdin         # userids on stdin
#
#   # dry run -- print what would be deleted, touch nothing
#   DRY_RUN=1 devops/clear-state-cache.sh vprod ids.txt
#
set -euo pipefail

NS="${1:?usage: $0 <namespace> <userid-file|--stdin>}"
SRC="${2:?usage: $0 <namespace> <userid-file|--stdin>}"
DRY_RUN="${DRY_RUN:-0}"
REDIS_POD="${REDIS_POD:-gbv-redis-master-0}"
REDIS_SECRET="${REDIS_SECRET:-gbv-redis}"

if [ "$SRC" = "--stdin" ]; then
  mapfile -t IDS < <(grep -oE '[0-9]+' || true)
else
  [ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 1; }
  mapfile -t IDS < <(grep -oE '[0-9]+' "$SRC")
fi

[ "${#IDS[@]}" -gt 0 ] || { echo "no userids found in $SRC" >&2; exit 1; }

echo "namespace : $NS"
echo "redis pod : $REDIS_POD"
echo "userids   : ${#IDS[@]}"
echo

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN -- would delete these keys:"
  printf 'state:%s\n' "${IDS[@]}"
  exit 0
fi

PW="$(kubectl -n "$NS" get secret "$REDIS_SECRET" -o go-template='{{index .data "redis-password" | base64decode}}')"
[ -n "$PW" ] || { echo "could not read redis password from secret $REDIS_SECRET" >&2; exit 1; }

# Build the key list once and pipe a single script in, rather than one exec per
# userid -- 50+ sequential kubectl execs is slow and noisy in the audit log.
{
  echo "EXISTS ${IDS[*]/#/state:}"
  printf 'DEL state:%s\n' "${IDS[@]}"
} > /tmp/.clear-state-cache.$$

echo "--- before ---"
kubectl -n "$NS" exec -i "$REDIS_POD" -c redis -- \
  env REDISCLI_AUTH="$PW" redis-cli EXISTS "${IDS[@]/#/state:}"

echo "--- deleting ---"
DELETED=$(kubectl -n "$NS" exec -i "$REDIS_POD" -c redis -- \
  env REDISCLI_AUTH="$PW" redis-cli DEL "${IDS[@]/#/state:}")
echo "keys deleted: $DELETED"

echo "--- after (should be 0) ---"
kubectl -n "$NS" exec -i "$REDIS_POD" -c redis -- \
  env REDISCLI_AUTH="$PW" redis-cli EXISTS "${IDS[@]/#/state:}"

rm -f /tmp/.clear-state-cache.$$

echo
echo "Done. State will be recomputed from the event log on each participant's"
echo "next event. Nothing has been sent to anyone."

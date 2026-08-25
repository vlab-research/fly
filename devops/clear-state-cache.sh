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
# Needed again, and more sharply, for the conversation-identity bug
# (planning/conversation-identity.md): state used to be keyed by user id alone,
# so a participant messaging two accounts shared one state blob and ended in a
# terminal ERROR whose tag no sweep retries. This script is the ONLY operational
# recovery for such a participant.
#
# THE KEY SHAPE
#
#   state:<platform>:<account_id>:<userid>     e.g. state:whatsapp:120386…:154197…
#
# built by makeKey() in replybot/lib/typewheels/statestore.js -- the single place
# that shape is written. The userid is the LAST component, so a participant is
# found by SUFFIX, and one participant may hold several keys (one per account
# they have messaged). All of them are cleared.
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
# SCAN, NEVER KEYS. This runs against production Redis, where KEYS is a
# full-keyspace stall that blocks the server for every other client. Discovery
# goes through `redis-cli --scan`, which is a SCAN cursor loop (redis-cli owns
# the cursor and terminates when it returns to 0) executed server-side in ONE
# round trip. Verified against a real Redis with MONITOR: the wire carries
# "scan" commands and no "keys" command.
#
# USAGE
#
#   devops/clear-state-cache.sh <namespace> <userid-file>   # one userid per line
#   devops/clear-state-cache.sh <namespace> --stdin         # userids on stdin
#
#   # dry run -- print what WOULD be deleted, touch nothing
#   DRY_RUN=1 devops/clear-state-cache.sh vprod ids.txt
#
# TESTING ONLY
#
#   Point the script at a local Redis instead of a cluster pod. Skips the
#   kubectl secret lookup entirely.
#
#   REDIS_CLI_OVERRIDE='docker exec my-redis redis-cli' \
#     devops/clear-state-cache.sh test ids.txt
#
set -euo pipefail

NS="${1:?usage: $0 <namespace> <userid-file|--stdin>}"
SRC="${2:?usage: $0 <namespace> <userid-file|--stdin>}"
DRY_RUN="${DRY_RUN:-0}"
REDIS_POD="${REDIS_POD:-gbv-redis-master-0}"
REDIS_SECRET="${REDIS_SECRET:-gbv-redis}"
REDIS_CLI_OVERRIDE="${REDIS_CLI_OVERRIDE:-}"

if [ "$SRC" = "--stdin" ]; then
  mapfile -t IDS < <(grep -oE '[0-9]+' || true)
else
  [ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 1; }
  mapfile -t IDS < <(grep -oE '[0-9]+' "$SRC")
fi

[ "${#IDS[@]}" -gt 0 ] || { echo "no userids found in $SRC" >&2; exit 1; }

# The k8s secret is read ONCE, not once per invocation. Reading it inside
# redis_cli() would fire a `kubectl get secret` for every Redis call -- with one
# discovery pass plus three verification calls that is 4 API round trips per run
# either way, but the earlier version of this script did it per userid, which for
# a 50-userid recovery list meant ~200 kubectl calls: minutes of wall time and a
# wall of audit-log noise for work that needs four.
PW=""
if [ -z "$REDIS_CLI_OVERRIDE" ]; then
  PW="$(kubectl -n "$NS" get secret "$REDIS_SECRET" -o go-template='{{index .data "redis-password" | base64decode}}')"
  [ -n "$PW" ] || { echo "could not read redis password from secret $REDIS_SECRET" >&2; exit 1; }
fi

# The single seam between this script and Redis. Everything below goes through
# it, which is what makes the local-testing override a one-variable change
# rather than a fork of the script.
redis_cli() {
  if [ -n "$REDIS_CLI_OVERRIDE" ]; then
    # Word-split deliberately: the override is a command plus its arguments.
    # shellcheck disable=SC2086
    $REDIS_CLI_OVERRIDE "$@"
  else
    kubectl -n "$NS" exec -i "$REDIS_POD" -c redis -- \
      env REDISCLI_AUTH="$PW" redis-cli "$@"
  fi
}

echo "namespace : $NS"
if [ -n "$REDIS_CLI_OVERRIDE" ]; then
  echo "redis     : LOCAL OVERRIDE -- $REDIS_CLI_OVERRIDE"
else
  echo "redis pod : $REDIS_POD"
fi
echo "userids   : ${#IDS[@]}"
echo

# ONE scan pass for ALL userids and BOTH key shapes.
#
# A per-userid `--pattern state:*:*:<userid>` would filter server-side, but each
# pattern is still a full iteration of the keyspace, so N userids cost N passes.
# `state:*` is one pass; it is still filtered server-side (we never receive
# non-state keys), and the per-userid selection happens locally, below, where it
# is free. This also means the deprecated flat shape needs no second pass -- one
# pattern covers both.
echo "--- scanning (SCAN, one pass) ---"
mapfile -t STATE_KEYS < <(redis_cli --scan --pattern 'state:*')
echo "state keys in keyspace: ${#STATE_KEYS[@]}"

# Exact-match selection, anchored at both ends. Two shapes are accepted:
#
#   state:<platform>:<account>:<userid>   the current shape
#   state:<userid>                        TRANSITIONAL -- the old flat shape.
#
# The flat branch exists only to catch keys written by a replybot build from
# before the cutover. Those keys carry a 24h TTL, so 24h after the last
# pre-cutover pod is gone there can be none left: DELETE THE FLAT BRANCH THEN.
# It is a dated leftover, not a supported shape.
#
# Anchoring matters: an unanchored match on a userid would also clear a
# participant whose id merely has the target as a prefix (15419799714 vs
# 154197997140). Non-destructive or not, clearing a stranger's conversation is
# not something a recovery script should do quietly.
all_keys=()
for userid in "${IDS[@]}"; do
  found=0
  for key in ${STATE_KEYS[@]+"${STATE_KEYS[@]}"}; do
    if [[ "$key" == "state:$userid" ]] \
      || [[ "$key" =~ ^state:[^:]+:[^:]+:"$userid"$ ]]; then
      all_keys+=("$key")
      found=$((found + 1))
    fi
  done
  echo "  $userid -> $found key(s)"
done
echo

if [ "${#all_keys[@]}" -eq 0 ]; then
  echo "No cached state found for any of these userids. Nothing to do --"
  echo "their next event will replay from the log regardless."
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN -- would delete these ${#all_keys[@]} key(s):"
  printf '  %s\n' "${all_keys[@]}"
  echo
  # Read-only confirmation that the keys are real and still present. Deletes
  # nothing. Unlike the previous version of this script, the list above is the
  # list SCAN actually returned, not a guess assembled from the userid -- the
  # platform and account components are not knowable from the input.
  echo "still present (EXISTS, read-only): $(redis_cli EXISTS "${all_keys[@]}")"
  exit 0
fi

echo "--- before ---"
redis_cli EXISTS "${all_keys[@]}"

echo "--- deleting ---"
printf '  %s\n' "${all_keys[@]}"
DELETED=$(redis_cli DEL "${all_keys[@]}")
echo "keys deleted: $DELETED"

echo "--- after (should be 0) ---"
redis_cli EXISTS "${all_keys[@]}"

echo
echo "Done. State will be recomputed from the event log on each participant's"
echo "next event. Nothing has been sent to anyone."

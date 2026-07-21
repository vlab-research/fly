#!/bin/bash
# NOT `set -e`: this is a best-effort health check that must DEGRADE gracefully
# (report a datasource as unreachable) rather than abort on the first non-zero
# command (a curl to a not-yet-ready port-forward, a jq -e miss, a bc on null).
set -o pipefail

# study-health.sh — end-to-end platform + study health check
# Returns JSON with verdict on platform/study health

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
LOG_DIR="${TMPDIR:-/tmp}"
LOG_FILE="${LOG_DIR}/study-health-${TIMESTAMP}.log"
LOCK_FILE="${LOG_DIR}/study-health-forwards.lock"
TEMP_JSON="${LOG_DIR}/study-health-${TIMESTAMP}.json"

# Unique local ports to avoid collisions with sibling agents
PROM_PORT=9190
ALERTMGR_PORT=9193
DB_PORT=26357

# Port-forward PIDs (to clean up on exit)
PROM_PID=""
ALERTMGR_PID=""
DB_PID=""

# Log function
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

cleanup() {
    log "Cleaning up port-forwards..."

    # Release lock before killing forwards
    if [ -f "$LOCK_FILE" ]; then
        rm -f "$LOCK_FILE"
    fi

    # Kill port-forwards if we spawned them
    if [ -n "$PROM_PID" ]; then
        kill $PROM_PID 2>/dev/null || true
    fi
    if [ -n "$ALERTMGR_PID" ]; then
        kill $ALERTMGR_PID 2>/dev/null || true
    fi
    if [ -n "$DB_PID" ]; then
        kill $DB_PID 2>/dev/null || true
    fi

    # Give processes time to exit
    sleep 1

    log "Cleanup complete"
}

trap cleanup EXIT

# Set up port-forwards (serialize to avoid conflicts)
setup_forwards() {
    log "Setting up port-forwards..."

    # Wait for lock (simple spinlock)
    local MAX_WAIT=30
    local ELAPSED=0
    while [ -f "$LOCK_FILE" ] && [ $ELAPSED -lt $MAX_WAIT ]; do
        sleep 1
        ELAPSED=$((ELAPSED + 1))
    done

    if [ $ELAPSED -ge $MAX_WAIT ]; then
        log "WARNING: Lock file still held after ${MAX_WAIT}s, proceeding anyway"
    fi

    # Create lock
    echo "$$" > "$LOCK_FILE"

    # Prometheus
    log "Port-forwarding Prometheus (monitoring/prometheus-kube-prometheus-prometheus:9090 -> localhost:$PROM_PORT)..."
    kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-prometheus "$PROM_PORT:9090" > /dev/null 2>&1 &
    PROM_PID=$!

    # AlertManager
    log "Port-forwarding AlertManager (monitoring/prometheus-kube-prometheus-alertmanager:9093 -> localhost:$ALERTMGR_PORT)..."
    kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-alertmanager "$ALERTMGR_PORT:9093" > /dev/null 2>&1 &
    ALERTMGR_PID=$!

    # CockroachDB
    log "Port-forwarding CockroachDB (vprod/gbv-cockroachdb-public:26257 -> localhost:$DB_PORT)..."
    kubectl port-forward -n vprod svc/gbv-cockroachdb-public "$DB_PORT:26257" > /dev/null 2>&1 &
    DB_PID=$!

    # Wait for the forwards to ACTUALLY be ready — a fixed sleep raced the first
    # (broker) queries against an un-ready forward, which came back empty/null.
    # Gate on the query API actually ANSWERING (not just /-/ready), so the first
    # broker queries don't race a half-ready forward and come back null.
    local w=0
    until curl -s "http://localhost:$PROM_PORT/api/v1/query?query=up" 2>/dev/null | grep -q '"status":"success"' || [ $w -ge 25 ]; do
        sleep 1; w=$((w + 1))
    done
    until curl -sf "http://localhost:$ALERTMGR_PORT/-/ready" >/dev/null 2>&1 || [ $w -ge 30 ]; do
        sleep 1; w=$((w + 1))
    done
    local dbw=0
    until PGPASSWORD="" psql -h localhost -p "$DB_PORT" -U chatroach -d chatroach -tAc 'SELECT 1' >/dev/null 2>&1 || [ $dbw -ge 15 ]; do
        sleep 1; dbw=$((dbw + 1))
    done

    log "Port-forwards ready (prom+am after ${w}s, db after ${dbw}s)"
}

# Query Prometheus
query_prometheus() {
    local query="$1"
    local url="http://localhost:$PROM_PORT/api/v1/query"

    log "Querying Prometheus: $query"

    # Retry: the first queries can race a just-established port-forward. Accept
    # only a status=success response; otherwise back off and retry.
    local encoded resp attempt
    encoded=$(echo -n "$query" | jq -sRr @uri)
    for attempt in 1 2 3 4; do
        resp=$(curl -s --max-time 10 "$url?query=$encoded" 2>/dev/null)
        if echo "$resp" | jq -e '.status=="success"' >/dev/null 2>&1; then
            echo "$resp"; return 0
        fi
        sleep 1
    done
    echo "${resp:-'{"status":"error"}'}"
}

# Query AlertManager
query_alertmanager() {
    local url="http://localhost:$ALERTMGR_PORT/api/v2/alerts"

    log "Querying AlertManager"

    curl -s --max-time 10 "$url?filter=alertstate%3Dactive" 2>/dev/null || echo '[]'
}

# Query CockroachDB
query_cockroach() {
    local query="$1"

    log "Querying CockroachDB: $query"

    PGPASSWORD="" psql -h localhost -p "$DB_PORT" -U chatroach -d chatroach -t -A -F, -c "$query" 2>/dev/null || echo "ERROR"
}

# Extract numeric value from Prometheus result (safe for null/error)
prom_value() {
    # Reads a Prometheus query JSON from STDIN (callers pipe into it) and emits
    # the scalar value, or "null". (Previously read $1, which is empty on a pipe —
    # that silently blanked every broker metric.)
    local result; result=$(cat)
    echo "$result" | jq -r '.data.result[0]?.value[1]? // "null"' 2>/dev/null || echo "null"
}

# Main health check
main() {
    log "Starting study-health check at $TIMESTAMP"

    setup_forwards

    # Initialize temp JSON path (don't write template to stdout)
    local json_out="$TEMP_JSON"

    # ===== BROKER HEALTH =====
    log "Checking broker health..."

    local offline_partitions=$(query_prometheus 'max(kafka_controller_kafkacontroller_offlinepartitionscount)' | prom_value)
    local active_controller=$(query_prometheus 'sum(kafka_controller_kafkacontroller_activecontrollercount)' | prom_value)
    local under_replicated=$(query_prometheus 'max(kafka_server_replicamanager_underreplicatedpartitions)' | prom_value)

    # Kafka PVC free % (average across all kafka PVCs)
    local pvc_free_percent=$(query_prometheus 'avg(kubelet_volume_stats_available_bytes{persistentvolumeclaim=~"kafka-.*"} / kubelet_volume_stats_capacity_bytes{persistentvolumeclaim=~"kafka-.*"} * 100)' | prom_value)

    local broker_status="healthy"
    if [ "$offline_partitions" != "null" ] && [ -n "$offline_partitions" ]; then
        if (( $(echo "$offline_partitions > 0" | bc -l 2>/dev/null || echo 0) )); then
            broker_status="critical"
        fi
    fi
    if [ "$active_controller" != "null" ] && [ -n "$active_controller" ]; then
        if (( $(echo "$active_controller != 1" | bc -l 2>/dev/null || echo 0) )); then
            broker_status="critical"
        fi
    fi
    if [ "$under_replicated" != "null" ] && [ -n "$under_replicated" ]; then
        if (( $(echo "$under_replicated > 0" | bc -l 2>/dev/null || echo 0) )); then
            broker_status="degraded"
        fi
    fi
    if [ "$pvc_free_percent" != "null" ] && [ -n "$pvc_free_percent" ]; then
        if (( $(echo "$pvc_free_percent < 20" | bc -l 2>/dev/null || echo 0) )); then
            broker_status="degraded"
        fi
    fi

    # If every broker metric came back empty/null, Prometheus was unreachable —
    # do NOT claim "healthy". (prom_value can yield "" or "null".)
    if { [ -z "$offline_partitions" ] || [ "$offline_partitions" = "null" ]; } \
       && { [ -z "$active_controller" ] || [ "$active_controller" = "null" ]; } \
       && { [ -z "$under_replicated" ] || [ "$under_replicated" = "null" ]; } \
       && { [ -z "$pvc_free_percent" ] || [ "$pvc_free_percent" = "null" ]; }; then
        broker_status="unknown"
    fi

    log "Broker health: offline=$offline_partitions controller=$active_controller under_rep=$under_replicated pvc_free=$pvc_free_percent% status=$broker_status"

    # ===== CONSUMER LAG =====
    log "Checking consumer lag..."

    local drain_query='kafka:consumergroup_drain_seconds'
    local drain_result=$(query_prometheus "$drain_query")
    local drain_json=$(echo "$drain_result" | jq -r '.data.result[]? | select(.metric) | {group_id: .metric.group_id, topic_name: .metric.topic_name, drain_seconds: .value[1], drain_seconds_slo: "120"}' 2>/dev/null | jq -s '.')

    # ===== FIRING ALERTS =====
    log "Checking firing alerts..."

    local alerts_result=$(query_prometheus 'ALERTS{alertstate="firing"}')
    local alerts_json=$(echo "$alerts_result" | jq -r '.data.result[]? | {alertname: .metric.alertname, severity: .metric.severity, env: .metric.env, group_id: .metric.group_id, topic_name: .metric.topic_name}' 2>/dev/null | jq -s '.')

    # ===== COCKROACHDB ERROR ANOMALIES =====
    log "Checking error anomalies..."

    # Compact context: ERROR/BLOCKED counts by form (last 1h). Deliberately NO
    # surveys/users join — that join fans out (one shortcode maps to many survey
    # rows), which BOTH inflates the counts AND pulls owner-email PII into routine
    # output. The verdict comes from the spike query below, not this listing. If a
    # form is flagged abnormal, resolve its survey/owner as a targeted follow-up.
    local error_query_1h='
    SELECT current_form AS form, current_state AS state, count(*) AS count
    FROM states
    WHERE current_state IN ('"'"'ERROR'"'"', '"'"'BLOCKED'"'"')
      AND updated > NOW() - INTERVAL '"'"'1 hour'"'"'
    GROUP BY current_form, current_state
    ORDER BY count DESC LIMIT 25;
    '
    local error_result_1h=$(query_cockroach "$error_query_1h" 2>/dev/null || echo "ERROR")
    local error_spikes_1h="[]"
    if [ -n "$error_result_1h" ] && [ "$error_result_1h" != "ERROR" ]; then
        error_spikes_1h=$(echo "$error_result_1h" | awk -F',' 'NF>=3 && $3 ~ /^[0-9]+$/ {
            gsub(/^"|"$/, "", $1); gsub(/^"|"$/, "", $2);
            printf "{\"form\": \"%s\", \"state\": \"%s\", \"count\": %s},", $1, $2, $3
        }' | sed 's/,$//' | sed 's/^/[/' | sed 's/$/]/')
        [ -z "$error_spikes_1h" ] && error_spikes_1h="[]"
    fi

    # Same for a 24h window (context only).
    local error_query_24h='
    SELECT current_form AS form, current_state AS state, count(*) AS count
    FROM states
    WHERE current_state IN ('"'"'ERROR'"'"', '"'"'BLOCKED'"'"')
      AND updated > NOW() - INTERVAL '"'"'24 hours'"'"'
    GROUP BY current_form, current_state
    ORDER BY count DESC LIMIT 25;
    '
    local error_result_24h=$(query_cockroach "$error_query_24h" 2>/dev/null || echo "ERROR")
    local error_spikes_24h="[]"
    if [ -n "$error_result_24h" ] && [ "$error_result_24h" != "ERROR" ]; then
        error_spikes_24h=$(echo "$error_result_24h" | awk -F',' 'NF>=3 && $3 ~ /^[0-9]+$/ {
            gsub(/^"|"$/, "", $1); gsub(/^"|"$/, "", $2);
            printf "{\"form\": \"%s\", \"state\": \"%s\", \"count\": %s},", $1, $2, $3
        }' | sed 's/,$//' | sed 's/^/[/' | sed 's/$/]/')
        [ -z "$error_spikes_24h" ] && error_spikes_24h="[]"
    fi

    # Detect REAL spikes: compare each survey's last-1h ERROR/BLOCKED count to its
    # prior-24h hourly baseline. A survey is "abnormal" ONLY on a genuine spike
    # (>=5 recent AND >3x its baseline). Merely having errors is normal background
    # noise (users block the bot, dean retries, misconfigured single studies) and
    # must NOT, on its own, trip a platform-wide page. This is the fix for the
    # earlier false-positive that flagged every survey-with-any-error as a spike.
    local spike_query='
    WITH recent AS (
      SELECT current_form AS form, count(*) AS c
      FROM states
      WHERE current_state IN ('"'"'ERROR'"'"', '"'"'BLOCKED'"'"')
        AND updated > NOW() - INTERVAL '"'"'1 hour'"'"'
      GROUP BY current_form
    ),
    baseline AS (
      SELECT current_form AS form, count(*)::float / 24.0 AS per_hr
      FROM states
      WHERE current_state IN ('"'"'ERROR'"'"', '"'"'BLOCKED'"'"')
        AND updated > NOW() - INTERVAL '"'"'25 hours'"'"'
        AND updated <= NOW() - INTERVAL '"'"'1 hour'"'"'
      GROUP BY current_form
    )
    SELECT r.form, r.c, ROUND(COALESCE(b.per_hr, 0)::numeric, 2)
    FROM recent r LEFT JOIN baseline b ON r.form = b.form
    WHERE r.c >= 5 AND r.c > 3 * COALESCE(b.per_hr, 0)
    ORDER BY r.c DESC;
    '
    local cockroach_reachable=true
    [ "$error_result_1h" = "ERROR" ] && cockroach_reachable=false
    local spike_result=$(query_cockroach "$spike_query" 2>/dev/null || echo "ERROR")
    [ "$spike_result" = "ERROR" ] && cockroach_reachable=false

    local abnormal_surveys="[]"
    local abnormal_count=0
    if [ "$cockroach_reachable" = true ] && [ -n "$spike_result" ]; then
        abnormal_surveys=$(echo "$spike_result" | awk -F',' 'NF>=3 && $2 ~ /^[0-9]+$/ {
            gsub(/^"|"$/, "", $1);
            printf "{\"form\": \"%s\", \"recent_1h\": %s, \"baseline_per_hr\": %s},", $1, $2, $3
        }' | sed 's/,$//' | sed 's/^/[/' | sed 's/$/]/')
        [ -z "$abnormal_surveys" ] && abnormal_surveys="[]"
        abnormal_count=$(echo "$abnormal_surveys" | jq 'length' 2>/dev/null || echo 0)
    fi

    local error_anomaly_verdict="no_anomalies"
    if [ "$cockroach_reachable" != true ]; then
        error_anomaly_verdict="unknown"
    elif [ "$abnormal_count" -ge 3 ]; then
        error_anomaly_verdict="platform_regression"
    elif [ "$abnormal_count" -gt 0 ]; then
        error_anomaly_verdict="study_issue"
    fi

    log "Error anomalies: abnormal_surveys=$abnormal_count reachable=$cockroach_reachable verdict=$error_anomaly_verdict"

    # ===== SYNTHESIZE VERDICT =====
    log "Synthesizing verdict..."

    local overall_status="green"
    local summary=""
    local actions_arr="[]"

    if [ "$broker_status" = "critical" ]; then
        overall_status="critical"
        summary="Kafka broker CRITICAL — offline partitions or controller failure"
        actions_arr='["Check Kafka broker pods (kubectl -n default get pods -l app=kafka)", "Inspect broker logs", "Check disk space (KafkaBrokerDiskSpaceCritical)"]'
    elif [ "$broker_status" = "degraded" ]; then
        overall_status="degraded"
        summary="Kafka broker DEGRADED — under-replication or low disk"
        actions_arr='["Check under-replicated partitions", "Monitor Kafka PVC free space"]'
    fi

    if echo "$drain_json" | jq -e '.[] | select((.drain_seconds | tonumber) > (.drain_seconds_slo | tonumber))' > /dev/null 2>&1; then
        if [ "$overall_status" = "green" ]; then
            overall_status="degraded"
        fi
        summary="$summary Consumer lag exceeds SLO for one or more groups"
        if [ "$actions_arr" = "[]" ]; then
            actions_arr='["Investigate slow consumer groups", "Check downstream dependencies (CockroachDB, Facebook Graph)"]'
        fi
    fi

    if [ "$error_anomaly_verdict" = "platform_regression" ]; then
        overall_status="critical"
        summary="$summary PLATFORM REGRESSION — ≥3 surveys spiking simultaneously"
        actions_arr='["Page platform owner", "Investigate recent deploys", "Check replybot/message-worker logs"]'
    elif [ "$error_anomaly_verdict" = "study_issue" ]; then
        if [ "$overall_status" = "green" ]; then
            overall_status="degraded"
        fi
        summary="$summary Study-level error spike (1-2 surveys); ticket to owner"
    fi

    # Don't report green when a datasource was unreachable — surface it instead.
    if [ "$broker_status" = "unknown" ] || [ "$error_anomaly_verdict" = "unknown" ]; then
        if [ "$overall_status" = "green" ]; then
            overall_status="unknown"
        fi
        summary="$summary (some checks unreachable — see 'unreachable' flags)"
    fi

    if [ -z "$summary" ]; then
        summary="Platform healthy — all brokers up, consumers draining, no error spikes."
    fi

    log "Final verdict: $overall_status"

    # ===== WRITE FINAL JSON =====
    # Ensure numeric values are properly quoted or nullified
    local offline_partitions_json="${offline_partitions:-null}"
    [ "$offline_partitions_json" = "" ] && offline_partitions_json="null"
    local active_controller_json="${active_controller:-null}"
    [ "$active_controller_json" = "" ] && active_controller_json="null"
    local under_replicated_json="${under_replicated:-null}"
    [ "$under_replicated_json" = "" ] && under_replicated_json="null"
    local pvc_free_percent_json="${pvc_free_percent:-null}"
    [ "$pvc_free_percent_json" = "" ] && pvc_free_percent_json="null"

    local final_json=$(cat <<ENDJSON
{
  "timestamp": "$TIMESTAMP",
  "platform_status": "$overall_status",
  "broker_health": {
    "offline_partitions": $offline_partitions_json,
    "active_controller_count": $active_controller_json,
    "under_replicated_partitions": $under_replicated_json,
    "kafka_pvc_free_percent": $pvc_free_percent_json,
    "status": "$broker_status"
  },
  "consumer_lag": {
    "groups": $drain_json,
    "unreachable": false
  },
  "error_anomalies": {
    "abnormal_surveys": $abnormal_surveys,
    "abnormal_surveys_count": $abnormal_count,
    "error_states_by_form_1h": $error_spikes_1h,
    "error_states_by_form_24h": $error_spikes_24h,
    "verdict": "$error_anomaly_verdict",
    "unreachable": $([ "$cockroach_reachable" = true ] && echo false || echo true)
  },
  "firing_alerts": $alerts_json,
  "verdict": {
    "status": "$overall_status",
    "summary": "$summary",
    "actions": $actions_arr
  }
}
ENDJSON
)

    # Validate and output JSON
    if echo "$final_json" | jq empty 2>/dev/null; then
        echo "$final_json" | jq '.'
    else
        log "WARNING: JSON validation failed, outputting raw"
        echo "$final_json"
    fi

    log "Health check complete"
}

main "$@"

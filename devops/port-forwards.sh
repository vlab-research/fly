#!/usr/bin/env bash
# Opens the kubectl port-forwards that the local MCP servers and the
# /study-health skill expect. There is NO ingress on the monitoring stack (by
# design — no k8s auth/MFA model), so local tooling reaches the cluster via
# these forwards, exactly like the postgres MCP server reaches its DB on
# localhost.
#
#   Prometheus   :9090  — required by the 'prometheus' MCP server (~/.claude.json)
#   AlertManager :9093  — used by /study-health (active-alert view)
#   CockroachDB  :26257 — used by /study-health (states / error analytics), svc
#                          gbv-cockroachdb-public in vprod
#
# Idempotent: skips a forward whose local port is already listening. Backgrounds
# each forward; stop them all with:  pkill -f 'kubectl.*port-forward'
set -uo pipefail

fwd() { # name  local:remote  svc  namespace
  local name=$1 mapping=$2 svc=$3 ns=$4
  local lport=${mapping%%:*}
  if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":${lport} "; then
    echo "[$name] localhost:${lport} already in use — skipping"
    return
  fi
  kubectl -n "$ns" port-forward "svc/$svc" "$mapping" >"/tmp/pf-${name}.log" 2>&1 &
  echo "[$name] -> localhost:${lport} (svc/$svc in $ns, pid $!, log /tmp/pf-${name}.log)"
}

fwd prometheus   9090:9090   prometheus-kube-prometheus-prometheus   monitoring
fwd alertmanager 9093:9093   prometheus-kube-prometheus-alertmanager monitoring
fwd cockroach    26257:26257 gbv-cockroachdb-public                  vprod

echo
echo "Forwards backgrounded. The 'prometheus' MCP server queries http://localhost:9090."
echo "Stop everything with:  pkill -f 'kubectl.*port-forward'"

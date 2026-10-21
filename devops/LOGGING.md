# Logs

Fly and vlab run in one GKE cluster (`gke_toixotoixo_europe-west1-b_toixo`):
production in namespace `vprod`, staging in `vstag`. Their container logs land
in three places, and each keeps a different amount of history. **For anything
older than a few hours, use Loki.**

| Where | History | Use it for |
|---|---|---|
| Loki (`monitoring/loki`) | Everything since 2026-10-01: no retention is set, so it keeps logs until its 50 Gi disk fills | Investigating anything in the past |
| `kubectl logs` | Only the pod's current life. Cronjobs keep their last few pods; a deploy or node restart wipes the rest | Watching something live |
| Cloud Logging (`_Default` bucket) | **3 days** | Not much. It is not the archive |

The GCS sinks into `gs://gbv-logs` keep only narrow slices: replybot errors,
and app logs at WARNING and above. They are not a general archive.

## Querying Loki

The monitoring stack has no ingress apart from Grafana, so query Loki through a
port-forward. `./port-forwards.sh` opens one on `localhost:3100`, alongside
Prometheus, AlertManager and CockroachDB:

```bash
kubectl -n monitoring port-forward svc/loki 3100:3100
```

The labels are `namespace`, `container`, `pod`, `app`, `job` and `stream`.
`container` is the name a values file gives a service: `conf-dashboard` is
the vlab API, and `adopt-ads`, `adopt-recruitment-data` and `adopt-audience`
are the adopt cronjobs. `replybot`, `dean` and `dinersclub` belong to Fly.
Promtail also ships Kafka topics `vlab-prod-payment` and `promtail*` under
`job="kafka"`.

```bash
# every throttling error from Meta in one adopt cronjob, for one day
curl -s -G localhost:3100/loki/api/v1/query_range \
  --data-urlencode 'query={namespace="vprod",container="adopt-ads"} |= "\"code\": 17"' \
  --data-urlencode start=2026-10-06T00:00:00Z \
  --data-urlencode end=2026-10-06T23:59:59Z \
  --data-urlencode limit=5000 \
  | jq -r '.data.result[].values[][1]'
```

- **Query one day at a time.** One request can return at most `limit` lines
  (5000 here). A request over many days of a busy container can also make Loki
  drop the connection.
- **Filter out health checks** on API containers with `!= "GET /health"`. They
  are most of `conf-dashboard`'s output.
- **A Python traceback or a Meta error body is many lines,** one Loki entry
  each. To find out which call failed, match the `Path:` line, not the
  message.

You can also browse Loki in Grafana at `grafana.vlab.digital`. Its Loki data
source is provisioned by the loki-stack chart.

## How Loki is installed

The Helm release is `loki` in namespace `monitoring`, chart
`grafana/loki-stack` 2.6.5, with values from [`loki.yaml`](loki.yaml). It is
not part of the `vlab` umbrella chart. Change its values with:

```bash
helm upgrade loki grafana/loki-stack --version 2.6.5 -n monitoring -f loki.yaml
```

Cloud Logging's `_Default` sink excludes Loki's own logs.

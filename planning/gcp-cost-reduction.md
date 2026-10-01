# GCP Cost Reduction — Findings & Quick Wins

**Project:** `toixotoixo`. **Cluster:** `toixo`, zone `europe-west1-b`, one pool
`bigpool` of 4 × `e2-highmem-4`.

**Status (2026-10-01):** quick wins identified, **none applied**. Prices below are
list-price estimates and have not been checked against the bill. Get the billing
breakdown by service and SKU before ranking anything bigger than these.

CockroachDB, which sizes the node pool, has its own plans. Start at
[`documentation/cockroachdb-storage.md`](../documentation/cockroachdb-storage.md).

## Where the money probably is

| Item | Shape | Rough list price / month |
|---|---|---|
| Compute | 4 × `e2-highmem-4` | largest line by far |
| CRDB disks | 4 × 240Gi `pd-ssd` (~110 GiB used each) | ~$180 |
| Loki disk | 600Gi `pd-standard` (7.2 GB used) | ~$25 |
| `dropboxer` disk | 1000 GB `pd-standard`, VM off since 2019 | ~$40 |
| Kafka, MinIO, misc. disks | ~700 GB mixed | ~$40 |

Compute is the line worth engineering. Two levers:

1. **Committed use discounts.** A 1- or 3-year commitment on the pool's vCPU and
   memory needs no engineering. Check whether one exists before anything else,
   and size it to the pool you expect *after* the CockroachDB memory work, not
   today's.
2. **`e2-highmem-4` → `e2-standard-4`.** Blocked on CockroachDB memory; see
   `planning/cockroachdb-memory-and-topology-plan.md`.

## Quick wins

Each of these deletes live state that no repo file governs, so each needs an
explicit go-ahead. Run them by hand, and record the outcome here.

### 1. `dropboxer` — 1000 GB disk on a VM stopped since 2019-08-11

`g1-small` VM `dropboxer`, created 2019-07-22, last stopped 2019-08-11. Its
1000 GB `pd-standard` boot disk has been billed ever since. Nothing in the repo
references it. The contents are unknown, and the name suggests a Dropbox mirror,
so take an archive snapshot first (billed on used bytes only, not the 1000 GB):

```bash
gcloud compute snapshots create dropboxer-final-2026-10 \
  --source-disk=dropboxer --source-disk-zone=europe-west1-b \
  --snapshot-type=ARCHIVE --storage-location=europe-west1
gcloud compute instances delete dropboxer --zone europe-west1-b --delete-disks=all
```

### 2. Unused static IP `vlab` (34.77.32.208)

Reserved 2023-06-05, status `RESERVED`, no users, no forwarding rule. Ingress
serves from `35.241.211.222`, an **ephemeral** address on the ingress-nginx
LoadBalancer. Two options:

- Release `vlab`: `gcloud compute addresses delete vlab --region europe-west1`.
- Or promote the ingress IP to static and release `vlab`. Recreating that
  Service today would change the IP behind every `*.vlab.digital` record.
  Promoting it costs nothing while it is in use.

### 3. Loki: 600Gi disk, 7.2 GB used

Retention is 720h (30 days), so 7.2 GB is steady state. 50Gi leaves ~7×
headroom.

**Config drift blocks a clean IaC apply.** The live release (`loki-stack`
2.6.5, revision 1, 2022) has `size: 50Gi` in its values; the PVC was expanded by
hand to 600Gi; and `devops/loki.yaml` says `100Gi` **and adds a
`vlab-prod-response` promtail topic** that the live release does not scrape.
Applying the repo file as-is would start ingesting a new Kafka topic. Decide
which is right, fix `devops/loki.yaml`, then:

```bash
# A PVC cannot shrink. Recreate it; the last 30 days of logs are lost.
kubectl -n monitoring delete sts loki --cascade=orphan
kubectl -n monitoring delete pvc storage-loki-0
helm upgrade loki grafana/loki-stack --version 2.6.5 -n monitoring -f devops/loki.yaml
```

### 4. Orphaned PVCs (~20 GB, ~$1/month — hygiene)

Bound but with no workload:

| Namespace | PVC | Age |
|---|---|---|
| default | `datadir-gbv-cockroachdb-0`, `datadir-gbv-kafka-0`, `data-gbv-kafka-0`, `data-gbv-zookeeper-0` | 4–6 years |
| monitoring | `alertmanager-prometheus-prometheus-oper-alertmanager-db-…-0` | 6 years |
| vprod | `datadir-db-cockroachdb-0`, `redis-data-fly-redis-master-0`, `data-redis-redis-ha-server-0` | ~144 days |

All have reclaim policy `Delete`, so `kubectl delete pvc` removes the disk. Not
worth money; worth it to stop them confusing the next audit. The `vprod` three
look like May 2026 experiments; confirm before deleting.

## Not a quick win, worth a look

- **Kafka** holds ~12 GiB of memory reservations, about a quarter of the
  cluster, and `kafka-cruisecontrol` uses 3.5 GiB. After CockroachDB shrinks,
  Kafka is the largest memory consumer.
- **`gbv-exporter`**: two replicas at 1.9 and 2.9 GiB each.
- **Staging** (`vstag`) runs on the production pool.

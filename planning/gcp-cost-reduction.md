# GCP Cost Reduction — Findings & Quick Wins

**Project:** `toixotoixo`. **Cluster:** `toixo`, zone `europe-west1-b`, one pool
`bigpool` of 4 × `e2-highmem-4`.

**Status (2026-10-01):**

- 1 `dropboxer` — ✅ done. Archive snapshot `dropboxer-final-2026-10` (READY,
  175 GB stored), then VM and 1000 GB disk deleted.
- 2 ingress IP — ✅ done. `35.241.211.222` reserved by Terraform as
  `ingress-nginx`, the Service pinned to it (helm revision 2), `vlab` released.
- 3 Loki — ✅ done. Reinstalled fresh (helm release `loki`, revision 1,
  2026-10-01) on a 50Gi `standard-rwo` volume; the 600Gi disk is deleted and
  previous logs were discarded (accepted). Loki was down ~25 minutes.
- 4 orphaned PVCs — not approved. Prices below are
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
# Wait for the snapshot to be READY before deleting.
gcloud compute snapshots describe dropboxer-final-2026-10 --format='value(status,storageBytes)'
gcloud compute instances delete dropboxer --zone europe-west1-b --delete-disks=all
```

Snapshot `dropboxer-final-2026-10` was started 2026-10-01.

### 2. Make the ingress IP permanent; release `vlab`

Ingress serves from `35.241.211.222`, an **ephemeral** address on the
ingress-nginx LoadBalancer. Recreating that Service would change the IP behind
every `*.vlab.digital` record on NS1. Separately, the static IP `vlab`
(34.77.32.208, reserved 2023-06-05) has no users and is billed while idle.

Staged:

- `infra/envs/prod/main.tf` — `google_compute_address.ingress` reserves
  `35.241.211.222` in place. Reserving an in-use ephemeral address promotes it,
  with no traffic interruption. `terraform plan`: 1 to add, 0 to change.
- `devops/ingress-nginx.yaml` — pins `controller.service.loadBalancerIP`. The
  render differs from the chart defaults in only that one line. The live release
  has no user-supplied values, so this is its first values file.

Apply, in this order:

```bash
cd infra/envs/prod && terraform apply
gcloud compute addresses list     # ingress-nginx: IN_USE
helm upgrade ingress-nginx ingress-nginx/ingress-nginx --version 4.10.1 \
  -n ingress-nginx -f devops/ingress-nginx.yaml
gcloud compute addresses delete vlab --region europe-west1
```

### 3. Loki: 600Gi disk, 7.2 GB used

Retention is 720h (30 days), so 7.2 GB is steady state; 50Gi leaves ~7×
headroom. The live release (`loki-stack` 2.6.5, revision 1, 2022-07) asks for
50Gi; the PVC was later expanded by hand to 600Gi.

`devops/loki.yaml` now matches the live release: `size: 50Gi`, and promtail
scrapes `vlab-prod-payment` and `^promtail.*` only. The file previously also
listed `vlab-prod-response`, which the live release has never scraped. **Whether
to collect it is an open question**, deliberately left out so the shrink changes
only the disk. `helm template` with the file renders identically to the live
values.

```bash
# A PVC cannot shrink, so recreate it. The last 30 days of logs are lost (accepted).
kubectl -n monitoring delete sts loki --cascade=orphan
kubectl -n monitoring delete pvc storage-loki-0
kubectl -n monitoring delete pod loki-0
helm upgrade loki grafana/loki-stack --version 2.6.5 -n monitoring -f devops/loki.yaml
kubectl -n monitoring get pvc storage-loki-0     # 50Gi, Bound
```

The old 600Gi disk's reclaim policy is `Delete`, so it goes with the PVC.

**Why it was a reinstall, not an upgrade.** The 2022 release carried a
`policy/v1beta1` PodSecurityPolicy in its stored release manifest. That API was
removed in Kubernetes 1.25, so both `helm upgrade` and `helm uninstall` failed on
it. `helm template` does not check API availability, so an offline render will
not catch this; use `kubectl apply --dry-run=server` on the render, or
`helm upgrade --dry-run=server`. The old release's objects and its
`sh.helm.release.v1.loki.v1` record were deleted, then `helm install` from
`devops/loki.yaml`, which sets `loki.rbac.pspEnabled: false`.

Re-create from scratch the same way:

```bash
helm install loki grafana/loki-stack --version 2.6.5 -n monitoring -f devops/loki.yaml
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

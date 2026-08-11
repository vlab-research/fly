# CockroachDB: Operator Migration + v25/v26 Upgrade Plan

**New here? Start at
[`documentation/cockroachdb-storage.md`](../documentation/cockroachdb-storage.md)** —
the measured ground truth for the cluster, and a map of all four CockroachDB documents.
The overall priority order across this work lives in
[`cockroachdb-memory-and-topology-plan.md`](./cockroachdb-memory-and-topology-plan.md);
the disk / index-drop work log is
[`cockroachdb-cost-reduction-plan.md`](./cockroachdb-cost-reduction-plan.md).
**This plan is not next in that order** — the no-upgrade work comes first.

> **⚠️ Status 2026-07-26 — read before acting on this plan.**
>
> - **Phase 1 (raise `cache` to 7Gi, `max-sql-memory` to 6Gi) is CANCELLED.** It is
>   backwards for the cost goal and half of it is a measured no-op. See
>   *Phase 1 — cancelled* below.
> - **This plan is dated.** Research was done ~May 2026 and hinges on operator GA
>   status that was "targeted 2025" and still `v1.0-rc`. Re-verify before scheduling
>   anything.
> - **Do Part 0 of
>   [`cockroachdb-memory-and-topology-plan.md`](./cockroachdb-memory-and-topology-plan.md)
>   first** — a live availability risk (two CRDB pods on one GKE node).
> - **Value separation is the one genuinely strong reason to upgrade**, and its value
>   is bigger than described here — see *Phase 5* below.

## Context

After today's v21.2 → v24.1 LTS recovery, we want to:

1. **Stay current** — v24.1 LTS is supported through Oct 2026, but the project's deployment story has moved to the cockroach-operator. The Helm chart we use (current major v13.x for v24.1) is in "security patches and bug fixes only" mode — no new features. Future versions (v25.4+, v26.x) require the operator.
2. **Reduce footprint / cost** — the biggest win available is **value separation in Pebble**, GA in v25.4 (default-on for values ≥256B). For our JSONB-heavy workload (`states.state_json`, `responses.metadata`, `surveys.metadata`) this means ~50% reduction in write amplification, ~20–30% IOPS drop, and lower compaction CPU. Net: same workload on smaller/cheaper hardware.
3. ~~**Headroom** — we are dramatically *under-allocated* on cache.~~
   ⚠️ **This premise is wrong and was the basis of the cancelled Phase 1.** It reasons
   from the *node's* 31 GiB, but the pod requests `8000Mi` and its **measured RSS is
   7.2–7.9 GiB** — 92–101% of its request, with one pod already over. There is no
   headroom to harvest. The goal is the opposite direction: shrink the pod so the pool
   can move from `e2-highmem-4` to `e2-standard-4`. See
   [`cockroachdb-memory-and-topology-plan.md`](./cockroachdb-memory-and-topology-plan.md).

Two non-negotiable things to decide up front:

- **TLS or not.** The operator strongly prefers TLS-enabled. Insecure mode is technically supported (omit cert secrets, set `tlsEnabled: false`) but it's an off-the-beaten-path config. Migrating to TLS during the operator move is the safer bet long term.
- **Operator GA timing.** As of research date (May 2026), cockroach-operator was still v1.0-rc, marked Public Preview. GA is targeted "2025" per docs. Verify status before starting.

## Recommended Path

Five phases, each independently valuable. Ship in order, don't combine.

```
Phase 1 — CANCELLED (see memory/topology plan for what replaces it)
Phase 2 — Install operator alongside (no migration yet)
Phase 3 — Rolling adoption of existing PVCs by operator
Phase 4 — Upgrade v24.1 → (v24.3 →) v25.4 LTS via operator
Phase 5 — Enable value separation explicitly + retune memory
```

---

## Phase 1 — ❌ CANCELLED (was: raise cache and SQL memory)

**Do not do this.** It was written before anyone measured the pod, and prod
measurements on 2026-07-26 invalidate both halves:

**`max-sql-memory: 3000Mi → 6Gi` is a no-op.** Actual usage is **3.5 MiB — 0.1%** of
the current budget (`sql.mem.root.current`, all four nodes). It is a ceiling, not an
allocation. Raising it changes nothing.

**`cache: 3500Mi → 7Gi` is backwards for the goal.** The premise was that RSS is
4.7 GiB with room to grow. It isn't — **measured RSS is 7.2–7.9 GiB against an
`8000Mi` (7.81 GiB) request**, and one pod is already *over* its request:

```
node 1: RSS 7.22 GiB   node 2: RSS 7.89 GiB   node 3: RSS 7.74 GiB   node 4: RSS 7.57 GiB
        (cache is the 3.66 GiB cgo component; Go heap ~0.9–1.9 GiB)
```

Raising cache to 7Gi would push RSS to ~12 GiB per pod. CockroachDB is already **60%
of all memory requests in the GKE cluster** and is the sole reason the pool runs
`e2-highmem-4` (32 GB) instead of `e2-standard-4` (16 GB). The goal is to get the pod
**down to ~`4000Mi`**, not up.

**The real tension this plan was reaching for is genuine, though:** the block cache
hit rate is only **75–82%**, so cache cannot simply be cut either. The way out is to
make the cache *more effective* rather than larger — which is Phase 5's value
separation, plus the range-size fix in
[`cockroachdb-memory-and-topology-plan.md`](./cockroachdb-memory-and-topology-plan.md).

**Replacement for this phase:** the free, no-upgrade memory work in that plan —
fix replica co-location (Part 0), then `range_max_bytes` 64 MiB → 512 MiB (Part 2),
a ~13× replica reduction that is where the Go heap actually goes.

---

## Phase 2 — Install Operator Alongside

**Goal:** get the operator installed in the cluster *without* touching CockroachDB. Operator just sits there until we point it at something.

```bash
# Verify operator status — check for GA tag before proceeding
git clone https://github.com/cockroachdb/helm-charts.git /tmp/crdb-helm-charts

helm install crdb-operator /tmp/crdb-helm-charts/cockroachdb-parent/charts/operator \
  -n cockroach-operator-system --create-namespace
```

Verify:
```bash
kubectl get pods -n cockroach-operator-system
kubectl get crd | grep cockroachlabs
# expect: crdbclusters.crdb.cockroachlabs.com, crdbnodes.crdb.cockroachlabs.com
```

The operator runs cluster-wide by default. If you want it scoped to `vprod` only, set `watchNamespaces: [vprod]` in operator chart values.

Nothing else changes. Helm-managed StatefulSet still owns the cluster.

---

## Phase 3 — Rolling Adoption (Helm StatefulSet → Operator-managed)

**Goal:** transfer ownership of existing pods/PVCs from Helm to the operator, one node at a time. PVCs (`datadir-gbv-cockroachdb-{0..3}`) are reused — no data movement.

The operator project ships a `migration-helper` binary specifically for this. **Test on a non-prod cluster first.**

```bash
# Build the helper
cd /tmp && git clone https://github.com/cockroachdb/cockroach-operator.git
cd cockroach-operator && make build  # produces bin/migration-helper

# Set context
export CRDBCLUSTER=gbv
export NAMESPACE=vprod
export CLOUD_PROVIDER=gcp
export REGION=<your-gke-region>

# Generate the operator manifests from current StatefulSet state
mkdir -p /tmp/crdb-manifests
bin/migration-helper build-manifest operator \
  --crdb-cluster $CRDBCLUSTER \
  --namespace $NAMESPACE \
  --cloud-provider $CLOUD_PROVIDER \
  --cloud-region $REGION \
  --output-dir /tmp/crdb-manifests
```

Then for each of nodes 3, 2, 1, 0 (high to low ordinal):

```bash
# Scale Helm StatefulSet down by 1
kubectl scale sts gbv-cockroachdb -n vprod --replicas=N-1

# Apply the corresponding CrdbNode manifest
kubectl apply -f /tmp/crdb-manifests/gbv-node-N.yaml

# Wait for the new operator-managed pod to be Ready and verify zero
# under-replicated ranges before next iteration
```

After all 4 nodes are operator-managed:

```bash
kubectl delete sts gbv-cockroachdb -n vprod  # the StatefulSet shell
kubectl apply -f /tmp/crdb-manifests/gbv-crdbcluster.yaml
```

At this point CockroachDB is operator-managed but still running v24.1.28. Helm release `gbv` no longer manages the database part (you'll want to set `cockroachdb.enabled: false` in the values to make this explicit, or remove the dep from `Chart.yaml`).

**Rollback** (per-node, before the final `delete sts`): re-scale the StatefulSet up, delete the corresponding CrdbNode. PVCs are untouched.

**TLS decision happens here.** If migrating from insecure → TLS, the migration-helper has a `migrate-certs` subcommand that handles cert generation. Plan a separate maintenance window for this — TLS toggle on a running cluster is unsafe.

**Per-node locality also becomes possible here.** The Helm chart templates `--locality`
as a single static string (`statefulset.yaml:215-216`), so every pod gets the same value
— useless as a failure domain and the reason the interim fix is hard anti-affinity
instead. The operator manages nodes individually, so this is the right point to give
each `CrdbNode` real locality. Until then, hard `podAntiAffinity` is the correct guard.

**Verify pod placement after every node adoption.** The whole point of Phase 3 is
replacing nodes one at a time; each replacement is a chance to reintroduce the
co-location problem.

---

## Phase 4 — Upgrade v24.1 → v25.4 LTS via Operator

Once operator-managed, upgrades are a single CR field change.

If the v24.1 → v25.4 jump runs into the same Pebble version-skip issue we hit at v22.2 → v23.2, step through:

```
v24.1.28 → v24.3.x → v25.2.x → v25.4.x
```

Each step is one edit to `spec.image.name` in the CrdbCluster CR (or the equivalent helm values), apply, wait for rolling restart, finalize cluster setting `version`. Same pattern as today, just in operator vocabulary.

The operator handles the rolling restart, PDB, finalization job orchestration. Manual steps drop to:
1. Edit image tag, apply
2. Wait for all CrdbNodes to be Ready on new image
3. `RESET CLUSTER SETTING cluster.preserve_downgrade_option;`
4. Confirm `SHOW CLUSTER SETTING version;`

---

## Phase 5 — Value Separation + Final Memory Retune

**This is the phase that justifies the whole upgrade.** Confirmed 2026-07-26: there is
no `storage.value_separation.*` setting on the running v24.1 cluster, so this genuinely
requires the version bump.

**Why it matters more than this plan originally said.** The framing here was disk and
write-amp. The bigger win is **memory**. Today the large `content` (raw event JSON)
column lives inline in sstables, so every cached block drags JSON payload with it — the
3.5 GiB block cache is mostly holding blob bytes that a keyed, ordered scan doesn't need
until the final projection. With values split into blob files, the same cache byte
budget holds far more *keys*. For this workload — hot path is a keyed ordered scan over
`(userid, timestamp)` — that is a large effective-cache multiplier.

**It is the thing that makes cutting `cache` possible without surrendering the (already
mediocre, 75–82%) hit rate**, and therefore the linchpin of the `8000Mi → 4000Mi` target
that drives the `e2-highmem-4 → e2-standard-4` machine-type change.

⚠️ **Verify the specifics before planning around them.** The "GA in v25.4, default-on
for values ≥256B" claim in this document has not been independently confirmed against
release notes. Do that first.

Once on v25.4, verify:

```sql
SHOW CLUSTER SETTING storage.value_separation.enabled;  -- expect: true
```

Soak 2 weeks. Then re-evaluate:
- **Disk usage** may grow ~20% short term (write amplification trade), then stabilize as compactions catch up
- **Write IOPS** should drop 30–50% on JSONB-heavy tables (visible in GCP monitoring)
- **CPU during compaction** should drop noticeably

Post-soak, the question is whether we can **shrink the cluster**. Revised targets based
on the 2026-07-26 measurements:

- **Memory per node — target `8000Mi` → ~`4000Mi`, not 6 GiB.** 6 GiB saves nothing that
  matters: the machine-type step from `e2-highmem-4` (32 GB) to `e2-standard-4` (16 GB)
  needs total cluster requests under ~51 GiB, which requires CRDB at ~4 GiB/pod. That is
  the number worth aiming at, and it is reachable only with value separation plus the
  range-size fix. CPU is not binding either way (43% of requests).
- **Replicas — 4 → 3 saves a node.** 🔴 **Hard precondition: fix the replica
  co-location risk first** (see the memory/topology plan Part 0). Today two CRDB pods
  share one GKE node with only `soft` anti-affinity; consolidating to 3 nodes while the
  scheduler can stack databases would make the exposure worse, not better.

Don't attempt the shrink until value separation has been on for 2+ weeks and metrics are
clearly stable.

---

## What NOT to Do (and Why)

- **Don't jump straight to v26.x.** It's an Innovation release with 6-month support. v25.4 LTS is the right floor.
- **Don't try to skip Phase 2/3 and migrate to operator + upgrade in one shot.** Each phase needs its own observation window.
- **Don't migrate to TLS *during* the operator adoption.** Two big changes at once → impossible to debug. Sequence them.
- **Don't move to CockroachDB Cloud Serverless** as a cost play right now. Disaggregated SQL/KV is interesting but it's a managed service migration with its own pricing model, not a self-hosted feature.

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Operator still pre-GA at execution time | High | Verify status before Phase 2; defer if still rc |
| TLS transition complexity | High | Separate window; use `migration-helper migrate-certs`; test in staging first |
| Adoption helper has edge cases on our PVC layout | Med | Mandatory dry-run on a staging cluster (we have one in `vstag`) |
| Value separation increases disk usage 20% short-term | Low | We have headroom on the 240Gi PVCs; monitor |
| ~~Cache bump in Phase 1 causes OOM~~ | — | **Moot — Phase 1 cancelled.** |
| Replica co-location survives the migration | **High** | Two CRDB pods share one GKE node *today*. Fix before Phase 3, and re-verify placement after each node adoption. |
| Single-zone cluster (`europe-west1-b`) | Med | All 4 nodes are in one zone; the operator move is a natural point to reconsider, but it is out of scope for this plan. |

## Files Likely to Change

- `devops/values/production.yaml` — ~~Phase 1: cache/sql memory bump~~ (cancelled).
  Still changes, but for `statefulset.podAntiAffinity.type: hard` — see the
  memory/topology plan Part 0.
- `devops/vlab/Chart.yaml` — Phase 3: remove cockroachdb dep (now operator-managed)
- New: `devops/operator/crdbcluster.yaml` — operator CR for vprod
- New: helmfile/release for the operator install in `cockroach-operator-system`

## Verification Per Phase

| Phase | What to check |
|-------|---------------|
| 1 | *(cancelled — see memory/topology plan)* |
| 2 | Operator pod healthy, CRDs registered, no impact on existing cluster |
| 3 | After each adoption: 0 under-replicated ranges, all services still able to read/write, PVC still bound |
| 4 | `SHOW CLUSTER SETTING version`, smoke test app reads/writes |
| 5 | Compaction CPU, write IOPS, disk usage trajectory |

## Schedule Suggestion

- ~~Phase 1: this week~~ — **cancelled.** In its place, do the no-upgrade memory work in
  [`cockroachdb-memory-and-topology-plan.md`](./cockroachdb-memory-and-topology-plan.md):
  topology fix (urgent), then index drops, then the range-size change.
- Phase 2: 2 weeks out, after operator GA confirmed
- Phase 3: scheduled maintenance window, ~1 hour active (per node ~15 min)
- Phase 4: rolling, ~half-day per major bump including soak
- Phase 5: passive — let value separation work, revisit shrink in a month

Total elapsed: 6–8 weeks calendar, mostly waiting for soak periods.

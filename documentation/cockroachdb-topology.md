# CockroachDB Topology & Replica Placement

## Overview

Production CockroachDB runs **4 pods at replication factor 3** on a GKE pool of
4 nodes. For that shape to survive a node failure — the entire reason for RF3 —
every pod must sit on its own machine. Nothing about that is automatic: the
upstream chart's default anti-affinity is *soft*, and for at least 22 days
production ran with two database pods stacked on one node.

`devops/values/production.yaml` therefore pins **hard** anti-affinity:

```yaml
cockroachdb:
  statefulset:
    podAntiAffinity:
      type: hard
      topologyKey: kubernetes.io/hostname
```

| Env | CRDB pods | RF | Anti-affinity | Why |
|---|---|---|---|---|
| Production (`vprod`) | 4 | 3 | **hard**, per hostname | One node's loss must never take 2 of 3 replicas |
| Staging (`vstag`) | 1 | 1 | not set (chart default `soft`) | Single pod — nothing to spread |

## The failure mode this prevents

With 4 nodes at RF3, each range picks 3 of the 4 nodes. Of the four possible
replica sets — `{1,2,3} {1,2,4} {1,3,4} {2,3,4}` — **two contain both node 3 and
node 4**. So if CRDB pods 3 and 4 share one machine, roughly **half of all ranges
have 2 of their 3 replicas on that machine**.

Losing it is then not a survivable single-node failure. It is quorum loss for
~half the cluster: unavailable ranges, and recovery only through
`cockroach debug unsafe-remove-dead-replicas`, which carries data-loss risk.

This was the live production state, measured 2026-07-26: `gbv-cockroachdb-1` and
`gbv-cockroachdb-3` were both on node `...-ijmm`, while `...-hhtr` ran no CRDB pod
at all. That is also why `ijmm` sat at 74% of its memory requests against `hhtr`'s
23%. The condition is **invisible in normal operation** — it only manifests during
exactly the event the cluster exists to survive.

## Why the other two guards don't cover it

**Soft anti-affinity is a preference, not a rule.** The chart default
(`statefulset.podAntiAffinity.type: soft`) renders as
`preferredDuringSchedulingIgnoredDuringExecution`. The scheduler weighs it and may
ignore it under any competing pressure. `IgnoredDuringExecution` further means a
bad placement never self-corrects once made.

**`topologySpreadConstraints` is inert here.** The chart default keys it on
`topology.kubernetes.io/zone` with `whenUnsatisfiable: ScheduleAnyway`. All four
nodes are in **`europe-west1-b`** — a single zone — so the constraint is trivially
satisfied and constrains nothing. It still renders in the manifest; do not read
its presence as protection.

**CockroachDB itself has no locality information.** `locality` is empty on all
four nodes, so the allocator treats them as 4 independent failure domains. It
cannot know that two CRDB nodes share a machine, and will freely place 2 of 3
replicas on that pair.

### Do not try to fix this with `conf.locality`

The chart templates locality as one static string for the whole StatefulSet
(`statefulset.yaml`: `--locality={{ . }}`). Every pod would report *identical*
locality, which tells the allocator nothing about failure domains — cosmetic at
best, actively misleading at worst. Per-pod locality requires downward-API
injection the chart does not support. **Hard anti-affinity is the correct and
sufficient fix.** Revisit locality only under the operator migration, where
per-node configuration is first-class.

## Applying it

Standard IaC flow — edit the values file, then:

```bash
helm upgrade gbv vlab -f values/production.yaml -n vprod
```

**This is a rolling restart of the production database, not a config no-op.**
Adding affinity changes the pod template, and the StatefulSet's
`updateStrategy` is `RollingUpdate`, so all four pods are recreated **one at a
time in descending ordinal order** (3 → 2 → 1 → 0), each waited on for Ready
before the next. With `terminationGracePeriodSeconds: 300` plus rejoin and
catch-up per pod, budget tens of minutes. Run it outside a traffic peak.

No manual `kubectl delete pod` is needed: each pod is rescheduled by the
controller under the new hard constraint as it comes back. The four GKE nodes
were replaced by a pool upgrade around 2026-09-20, and on 2026-10-01 the pods
happened to land on four distinct nodes:

| Pod | Node (2026-10-01) |
|---|---|
| `gbv-cockroachdb-0` | `3x0x` |
| `gbv-cockroachdb-1` | `wl4c` |
| `gbv-cockroachdb-2` | `39gm` |
| `gbv-cockroachdb-3` | `4v3q` |

That placement is luck, not configuration: the live StatefulSet still renders
`preferredDuringScheduling...`, and the next node replacement can stack two
pods again. With the placement already spread, the rollout moves nothing. Each
pod comes back on the node it left, because that is the only node without a
CockroachDB pod. **Re-check placement immediately before applying.** If two
pods share a node at that moment, the rollout moves the higher-ordinal one onto
the empty node.

The restart is safe at RF3: only one pod is down at a time, so every range keeps
at least 2 of 3 replicas and quorum throughout. The PDB (`budget.maxUnavailable:
1`) enforces this.

Preconditions:

- **The PVC can follow the pod.** Every `datadir-gbv-cockroachdb-*` is a zonal
  `pd-ssd` volume in `europe-west1-b`, the zone of every node in the pool.
- **The rendered diff is only the affinity block.** Verified 2026-10-01 by
  diffing `helm template` against the live StatefulSet's pod spec; the other
  differences are API-server defaults.

Afterwards, **wait for zero under-replicated ranges before starting any other
work** — notably the range-size and index migrations in
`planning/cockroachdb-memory-and-topology-plan.md`.

## The trade-off, deliberately accepted

With `replicas` equal to the node count and hard anti-affinity, there is no spare
machine. **If a node goes down, its CRDB pod cannot be rescheduled and stays
`Pending` until the node returns.**

This is correct for RF3 — the cluster is designed to serve through one node being
down, and the remaining 3 pods hold a full copy of every range. But it does mean
there is no automatic recovery onto a spare, and a `Pending` CRDB pod during an
incident is expected rather than a second fault.

**Do not "fix" this back to `soft`.** Doing so restores the quorum-loss exposure
described above, and it will not move anything anyway — anti-affinity binds only
at scheduling time. To gain a spare, add a 5th node to the pool instead.

This is also a **hard precondition for shrinking the cluster from 4 CRDB pods to
3**: you cannot safely consolidate while the scheduler is free to stack two
databases on one machine.

## Verification

```bash
# All four pods on four distinct nodes
kubectl get pods -n vprod -o wide | grep cockroachdb

# Rendered constraint must be requiredDuringScheduling..., not preferred...
kubectl -n vprod get sts gbv-cockroachdb \
  -o jsonpath='{.spec.template.spec.affinity.podAntiAffinity}'

# Node zones — all europe-west1-b today (see caveat below)
kubectl get nodes -L topology.kubernetes.io/zone,node.kubernetes.io/instance-type
```

```sql
-- Even replica distribution, and locality (still empty by design — see above)
SELECT node_id, round((metrics->>'replicas')::float, 0) AS replicas
FROM crdb_internal.kv_store_status ORDER BY node_id;

SELECT node_id, address, locality FROM crdb_internal.kv_node_status ORDER BY node_id;
```

Also watch the DB Console **Replication** dashboard for under-replicated ranges
returning to zero after the rollout.

## Known remaining exposure: single zone

All four nodes are in **`europe-west1-b`**, in one pool (`bigpool`). Hard
anti-affinity protects against losing a *machine*; it does nothing about losing a
*zone*. The cluster cannot survive a zone failure today.

Fixing that means a multi-zone pool plus real per-node locality so the allocator
spreads replicas across zones — which is the operator migration, not this change.
It is recorded here so the current posture is a conscious choice rather than an
accident.

Related: `vstag`'s CockroachDB pod also runs on `bigpool`, so staging and
production compete for the same machines.

## Cross-links

- `planning/cockroachdb-memory-and-topology-plan.md` — the plan this change came
  from (its Part 0); also carries the replica-count/memory work that this fix gates.
- `planning/cockroachdb-cost-reduction-plan.md` — index and disk reduction; its
  4→3 node consolidation depends on hard anti-affinity being in place first.
- `documentation/cockroachdb-storage.md` — measured cluster shape, table and index
  sizes, and the `messages` access pattern.
- `documentation/backups.md` — scheduled BACKUP, Workload Identity, and restore.

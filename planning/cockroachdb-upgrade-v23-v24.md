# CockroachDB Upgrade Plan: v22.2.19 → v23.2.30 → v24.1.28 (LTS)

## Context

We just finished upgrading from v21.2.17 → v22.1.22 → v22.2.19 to recover from the disappeared image. v22.2 is still EOL — we should keep going to v24.1 LTS (supported through Oct 2026).

CockroachDB only allows **one major version step at a time**, and a Helm chart bump is required at each step (the chart is locked to the appVersion).

| Step | CRDB version | Helm chart | Chart appVersion |
|------|--------------|------------|------------------|
| Now  | v22.2.19     | v10.0.4    | v22.2.4          |
| 1    | **v23.2.30** | **v12.0.5**| v23.2.5          |
| 2    | **v24.1.28** | **v13.0.3**| v24.1.3          |

(There is no v11.x chart — v11 was for v23.1, an Innovation release we skip.)

## Pre-existing config bugs to fix first

The audit caught three places where overrides land at the wrong key and are silently ignored:

| File | Wrong | Right |
|------|-------|-------|
| `devops/values/production.yaml` (~line 669) | `conf.budget.maxUnavailable: 1` | `statefulset.budget.maxUnavailable: 1` |
| `devops/values/staging.yaml` (~line 548) | `conf.budget.maxUnavailable: 0` | `statefulset.budget.maxUnavailable: 0` |
| `devops/values/integrations/cdb.yaml` (~line 9) | `conf.budget.maxUnavailable: 0` | `statefulset.budget.maxUnavailable: 0` |
| `devops/values/integrations/cdb.yaml` (~line 17) | top-level `resources:` | `statefulset.resources:` |

Net effect today: PodDisruptionBudget is not being applied at all in any environment. Worth fixing before the next chart bump.

## Step 1 — v22.2.19 → v23.2.30 (chart v10.0.4 → v12.0.5)

### Chart-level breaking changes (v10 → v12)

- **`tls.serviceAccount` is gone** → moved to `statefulset.serviceAccount`. We don't override this, so no action.
- **ServiceAccount now always created** (was TLS-only). Harmless, but a new resource will appear in the namespace.
- **Pods now run as UID 1000** (non-root, restricted caps, readonly fs). Triggered by `securityContext.enabled: true` (default). The chart's version-validation helper enables it only on CRDB ≥ v22.1.2 — we're on v22.2.19 so it will apply. **PVC permissions need to allow UID 1000** — this is the main risk.
- **Termination grace period 60s → 300s**. Slower drain, generally good.
- `tls.certs.useCertManagerV1CRDs` removed — we don't set it.

### CRDB v23.2 release-level concerns

- Schema is fine. Audit confirmed our STORED computed columns (`states.timeout_date`, `states.form_start_time`, `messages.hsh`, etc.) and `parse_timestamp()` continue to work.
- **Don't drop computed columns during the upgrade window** — there's a known v23.2.4+ bug where dropping virtual computed columns can fail.
- New finalization mechanism: `cluster.auto_upgrade.enabled = false` is preferred over `cluster.preserve_downgrade_option`. Either works.

### Procedure

1. **Prep PVCs for UID 1000** — verify with: `kubectl exec -n vprod gbv-cockroachdb-0 -- ls -ld /cockroach/cockroach-data` (should be writable by 1000). If owned by root only, the chart's init container handles `fsGroup: 1000` via pod security context, so it should adjust on first restart. Watch for permission errors in logs.

2. **Bump chart dependency** in `devops/vlab/Chart.yaml`:
   ```yaml
   - name: cockroachdb
     version: 12.0.5      # was 10.0.4
     repository: https://charts.cockroachdb.com/
   ```

3. **Re-fetch the chart**:
   ```bash
   cd devops/vlab && helm dependency update
   ```
   (will pull `cockroachdb-12.0.5.tgz` into `charts/`; old `cockroachdb-10.0.4.tgz` can be deleted)

4. **Update image tag** in both files: `v22.2.19` → `v23.2.30`

5. **Set the downgrade lock** (cluster is healthy, do this BEFORE helm upgrade):
   ```sql
   SET CLUSTER SETTING cluster.preserve_downgrade_option = '22.2';
   ```

6. **Deploy**:
   ```bash
   helm upgrade gbv vlab -f values/production.yaml -n vprod
   ```
   This is a normal rolling restart — quorum is healthy so the StatefulSet rollout works one pod at a time, no need to delete pods.

7. **Watch pods** roll one at a time:
   ```bash
   kubectl get pods -n vprod -w | grep cockroach
   ```

8. **Once all 4 are 1/1 Running on v23.2.30, finalize**:
   ```sql
   SHOW CLUSTER SETTING version;        -- should show 22.2-x
   RESET CLUSTER SETTING cluster.preserve_downgrade_option;
   -- wait for migration jobs to complete (UI Jobs page)
   SHOW CLUSTER SETTING version;        -- should show 23.2
   ```

9. **Smoke test**: confirm services can read/write — check botserver, dashboard logs for DB errors.

## Step 2 — v23.2.30 → v24.1.28 LTS (chart v12.0.5 → v13.0.3)

Stabilize on v23.2 for at least a day before doing this — gives time to catch any latent issues.

### Chart-level breaking changes (v12 → v13)

Minimal. v13 is essentially v12 with the new appVersion. No fields removed. New optional structured logging block (`conf.log.config`) — we don't need it; legacy `logtostderr` still works.

### CRDB v24.1 release-level concerns

- v24.1.28 already qualifies as LTS (LTS designation was made for v24.1.6+).
- New `sql.stats.non_indexed_json_histograms.enabled` setting — **on by default** in v23.2+, may increase memory during stats collection on our JSONB-heavy tables (`states.state_json`, `responses.metadata`, `surveys.metadata`). If we see memory pressure post-upgrade, set it to `false`.
- Schema is fine.

### Procedure

Same shape as Step 1:

1. **Bump chart dependency** to `12.0.5` → `13.0.3` in `devops/vlab/Chart.yaml`
2. `helm dependency update` in `devops/vlab`
3. **Update image tag** to `v24.1.28` in both files
4. **Set lock**: `SET CLUSTER SETTING cluster.preserve_downgrade_option = '23.2';`
5. `helm upgrade gbv vlab -f values/production.yaml -n vprod`
6. Watch rolling restart
7. Finalize: `RESET CLUSTER SETTING cluster.preserve_downgrade_option;`
8. Verify `SHOW CLUSTER SETTING version;` returns `24.1`

## Verification (after each step)

```sql
-- All nodes alive and on the new version
SELECT node_id, address, is_live, server_version FROM crdb_internal.gossip_nodes;

-- No invalid objects from any of the migrations
SELECT * FROM crdb_internal.invalid_objects;

-- Computed columns still produce values
SELECT count(*) FROM chatroach.states WHERE timeout_date IS NOT NULL;
SELECT count(*) FROM chatroach.messages WHERE hsh IS NOT NULL;
```

## Rollback notes

- **Before finalization** (lock still set): downgrade is possible — bump image tag back to the previous version, helm upgrade, done.
- **After finalization**: rollback requires backup/restore. Don't finalize until smoke tests pass.
- The image-pull deadlock risk we hit on the v22.1 step is gone — both v23.2 and v24.1 chart targets are well-supported, and the cluster is now healthy enough for normal rolling updates.

## Files touched

- `devops/vlab/Chart.yaml` — chart dep version (×2)
- `devops/vlab/charts/` — auto-managed by `helm dep update`
- `devops/values/production.yaml` — image.tag (×2), statefulset.budget fix
- `devops/values/integrations/cdb.yaml` — image.tag (×2), structure fix
- `devops/values/staging.yaml` — statefulset.budget fix (and we may also want to bump staging's CRDB version off of v21.2.17 — currently broken with the same image issue)

# Exodus Production Values Implementation Plan

**Date**: 2026-02-15
**Scope**: Add exodus configuration to production.yaml, fix stale documentation references

---

## 1. Required Reading

Before implementing, the build agent must read these files:

| File | Why |
|------|-----|
| `/home/nandan/Documents/vlab-research/fly/devops/values/production.yaml` | The file being modified. Understand YAML anchors, indentation, and service ordering. |
| `/home/nandan/Documents/vlab-research/fly/exodus/config/config.go` | Source of truth for all exodus env vars (lines 11-31). |
| `/home/nandan/Documents/vlab-research/fly/exodus/chart/values.yaml` | Chart defaults that production.yaml overrides. |
| `/home/nandan/Documents/vlab-research/fly/dashboard-server/config/index.js` | Line 27 and 86: `EXODUS_API_URL` env var used by dashboard-server. |
| `/home/nandan/Documents/vlab-research/fly/documentation/bail-systems.md` | Line 253: contains stale `BAILER_RATE_LIMIT` reference to fix. |

---

## 2. Changes to `devops/values/production.yaml`

### 2.1 Add `versionExodus` anchor (line 30, after `versionExporter`)

The version anchors are at lines 21-29. Add exodus after the last one:

```yaml
versionExporter: &vexporter v0.3.6
versionExodus: &vexodus v0.1.0
```

Insert `versionExodus: &vexodus v0.1.0` as a new line after line 29 (`versionExporter: &vexporter v0.3.6`).

### 2.2 Add `EXODUS_API_URL` to the dashboard env section

The dashboard `env:` block is at lines 389-427. Add `EXODUS_API_URL` after the last env var (`KAFKA_EXPORTS_TOPIC` at line 427):

```yaml
    - name: KAFKA_EXPORTS_TOPIC
      value: *exportertopic
    - name: EXODUS_API_URL
      value: "http://gbv-exodus"
```

Note: The exodus API service is created by the Helm chart `_helpers.tpl` as `{{ include "exodus.fullname" . }}`. With release name `gbv`, this resolves to `gbv-exodus`. The service listens on port 80 (service.yaml maps 80 -> 8080), so no port suffix is needed. The dashboard-server code defaults to `http://exodus-api:8080` but the actual Kubernetes service name is `gbv-exodus`.

**Indentation**: 4 spaces for `- name:`, matching the existing dashboard env vars which use 4-space indented list items.

### 2.3 Add full `exodus:` section

Insert the exodus section after the `exporter:` section (after line 585) and before the `cockroachdb:` section (line 587). This placement follows the convention of grouping custom services together before infrastructure services.

The env var ordering follows dean's pattern: CHATBASE_DATABASE, CHATBASE_USER, CHATBASE_PASSWORD, CHATBASE_HOST, CHATBASE_PORT, then service-specific vars. Dean uses 2-space indentation for its `env:` list items (no extra nesting under `env:`).

```yaml
exodus:
  image:
    repository: vlabresearch/exodus
    tag: *vexodus
    pullPolicy: IfNotPresent
  env:
  - name: CHATBASE_DATABASE
    value: "chatroach"
  - name: CHATBASE_USER
    value: "chatroach"
  - name: CHATBASE_PASSWORD
    value: ""
  - name: CHATBASE_HOST
    value: *host
  - name: CHATBASE_PORT
    value: "26257"
  - name: BOTSERVER_URL
    value: "http://gbv-botserver/synthetic"
  - name: DRY_RUN
    value: "false"
  - name: EXODUS_RATE_LIMIT
    value: "1s"
  - name: EXODUS_MAX_BAIL_USERS
    value: "100000"
  executor:
    enabled: true
    schedule: "* * * * *"
    resources:
      requests:
        cpu: 50m
        memory: 128Mi
  api:
    enabled: true
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
```

**Alignment notes:**

| Env Var | Value | Matches |
|---------|-------|---------|
| `CHATBASE_DATABASE` | `"chatroach"` | dinersclub (line 112), dean (line 147), scribble (line 233) |
| `CHATBASE_USER` | `"chatroach"` | dinersclub (line 118), dean (line 149) -- NOT `root` |
| `CHATBASE_PASSWORD` | `""` | dean (line 151), scribble (line 238) |
| `CHATBASE_HOST` | `*host` | dinersclub (line 114), dean (line 153) -- resolves to `gbv-cockroachdb-public` |
| `CHATBASE_PORT` | `"26257"` | dinersclub (line 116), dean (line 155) |
| `BOTSERVER_URL` | `"http://gbv-botserver/synthetic"` | dinersclub (line 110), dean (line 157) -- includes `/synthetic` path |

**Indentation style**: Dean uses 2-space indented list items under `env:` (no extra nesting). Dinersclub uses 4-space indented list items. Both patterns exist in the file. This plan follows dean's style (2-space) since exodus is also a Go service with both CronJobs and a Deployment, making it structurally closest to dean.

**Resources**: Taken from the exodus chart defaults (`exodus/chart/values.yaml` lines 88-98). These are reasonable starting points. The executor has higher limits (500m CPU, 512Mi memory) because it does batch processing, but we only specify `requests` in production.yaml to match the pattern used by dean's queries (lines 191-193).

---

## 3. Changes to `documentation/bail-systems.md`

### 3.1 Fix `BAILER_RATE_LIMIT` reference (line 253)

**Current text** (line 253):
```
The sender applies a configurable delay between HTTP POSTs to botserver (default: 1 request/second via `BAILER_RATE_LIMIT`). This prevents overwhelming botserver when a bail matches thousands of users.
```

**Replace with:**
```
The sender applies a configurable delay between HTTP POSTs to botserver (default: 1 request/second via `EXODUS_RATE_LIMIT`). This prevents overwhelming botserver when a bail matches thousands of users.
```

This is a simple string replacement: `BAILER_RATE_LIMIT` -> `EXODUS_RATE_LIMIT`. The service was renamed from "bailer" to "exodus" but this reference was missed.

### 3.2 Check for other stale references

No other stale references exist. A grep for `BAILER_` across the codebase confirms line 253 is the only remaining instance in documentation. The planning doc `BAILER_SERVICE_IMPLEMENTATION_PLAN.md` also uses the old name but that is a historical planning artifact, not active documentation -- leave it as-is.

---

## 4. Acceptance Criteria

1. `devops/values/production.yaml` contains a `versionExodus: &vexodus v0.1.0` anchor in the version anchors block (between lines 21-30).

2. `devops/values/production.yaml` contains an `exodus:` section with:
   - `image.tag` referencing `*vexodus`
   - All 8 env vars from `config.go` (CHATBASE_DATABASE, CHATBASE_USER, CHATBASE_PASSWORD, CHATBASE_HOST, CHATBASE_PORT, BOTSERVER_URL, DRY_RUN, EXODUS_RATE_LIMIT, EXODUS_MAX_BAIL_USERS) -- note: PORT is injected by the template, not values
   - `CHATBASE_HOST` uses the `*host` anchor (not a hardcoded string)
   - `CHATBASE_USER` is `"chatroach"` (not `"root"`)
   - `BOTSERVER_URL` is `"http://gbv-botserver/synthetic"` (not `"http://botserver/synthetic"`)
   - `executor.enabled: true` with resources
   - `api.enabled: true` with resources

3. `devops/values/production.yaml` dashboard `env:` section contains `EXODUS_API_URL` with value `"http://gbv-exodus"`.

4. `documentation/bail-systems.md` line 253 reads `EXODUS_RATE_LIMIT` instead of `BAILER_RATE_LIMIT`.

5. No other files are modified.

6. The YAML is valid (no syntax errors, anchors resolve correctly).

---

## 5. What NOT to Change

- **Do NOT modify `exodus/chart/values.yaml`** -- chart defaults are intentionally generic for local/dev use. Production overrides belong in `production.yaml`.
- **Do NOT modify `devops/vlab/values.yaml`** -- it already sets `exodus.api.enabled: true`. The production.yaml override will take precedence.
- **Do NOT modify `devops/vlab/Chart.yaml`** -- exodus is already listed as a dependency without a tag (always deployed). Adding a tag would be a separate decision.
- **Do NOT add `CHATBASE_MAX_CONNECTIONS` to exodus** -- exodus does not support this env var (it is not in `config.go`). Dinersclub and formcentral support it because their Go configs include it; exodus does not.
- **Do NOT add `envFrom` to exodus** -- the exodus chart templates do not support `envFrom`. If secrets are needed later, the chart templates must be updated first.
- **Do NOT modify `planning/BAILER_SERVICE_IMPLEMENTATION_PLAN.md`** -- it is a historical planning artifact using the old "bailer" name. It is not active documentation.
- **Do NOT change the exodus chart version** -- the `v0.1.0` version tag for the Docker image is a placeholder. The actual version to use should be confirmed by the user before deploying. The plan uses `v0.1.0` as a starting point.

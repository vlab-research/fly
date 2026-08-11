# Exodus System - Comprehensive Findings

## What Exodus Is

Exodus is a Go service for automated user bailouts in chatbot-driven surveys. When users get stuck, time out, or hit error states during surveys, exodus identifies them via configurable conditions (stored in the database) and redirects them to a destination form by sending synthetic events to botserver.

It is a single Go binary that runs in two modes from the same Docker image:

- **Executor** (`--mode=executor`): Runs once, processes all enabled bails, then exits. Deployed as a Kubernetes CronJob (every minute).
- **API** (`--mode=api`): Long-running HTTP server for CRUD management of bail configurations. Deployed as a Kubernetes Deployment.

## Environment Variables (Complete List from Source)

Source: `/home/nandan/Documents/vlab-research/fly/exodus/config/config.go` (lines 11-31)

All env vars are parsed via `caarlos0/env/v6` with struct tags.

| Variable | Go Field | Go Type | Default | Description | Used By |
|----------|----------|---------|---------|-------------|---------|
| `CHATBASE_DATABASE` | `DbName` | `string` | `chatroach` | CockroachDB database name | Both modes |
| `CHATBASE_HOST` | `DbHost` | `string` | `localhost` | Database host | Both modes |
| `CHATBASE_PORT` | `DbPort` | `int` | `5433` | Database port | Both modes |
| `CHATBASE_USER` | `DbUser` | `string` | `root` | Database user | Both modes |
| `CHATBASE_PASSWORD` | `DbPassword` | `string` | `""` (empty) | Database password | Both modes |
| `BOTSERVER_URL` | `BotserverURL` | `string` | `http://localhost:8080/synthetic` | Botserver synthetic event endpoint | Executor (required) |
| `EXODUS_RATE_LIMIT` | `RateLimit` | `time.Duration` | `1s` | Delay between bailout HTTP POSTs | Executor |
| `EXODUS_MAX_BAIL_USERS` | `MaxBailUsers` | `int` | `100000` | Max users to bail per definition per run | Executor |
| `PORT` | `Port` | `int` | `8080` | HTTP server listen port | API (required) |
| `DRY_RUN` | `DryRun` | `bool` | `false` | Log bailouts without actually sending | Executor |

Mode-specific validation (lines 53-61):
- Executor mode requires `BOTSERVER_URL` to be non-empty
- API mode requires `PORT` to be non-zero

Connection string construction (lines 43-50):
- If `CHATBASE_PASSWORD` is set: `postgres://user:pass@host:port/dbname?sslmode=disable`
- If empty: `postgres://user@host:port/dbname?sslmode=disable`

There are **NO** additional env vars referenced anywhere else in the codebase. The config struct is the single source of truth.

## Helm Chart Configuration

### Chart Source Location

The chart source lives at `/home/nandan/Documents/vlab-research/fly/exodus/chart/` and is packaged as `/home/nandan/Documents/vlab-research/fly/devops/vlab/charts/exodus-0.1.0.tgz`.

The packaged tgz contains identical files to the source chart directory:
- `Chart.yaml` (name: exodus, version: 0.1.0, appVersion: 1.0.0)
- `values.yaml`
- `templates/_helpers.tpl`
- `templates/cronjob.yaml`
- `templates/deployment.yaml`
- `templates/service.yaml`

### Chart Default Values

File: `/home/nandan/Documents/vlab-research/fly/exodus/chart/values.yaml`

```yaml
image:
  repository: vlabresearch/exodus
  pullPolicy: IfNotPresent
  tag: "latest"

env:
  - name: CHATBASE_DATABASE
    value: chatroach
  - name: CHATBASE_HOST
    value: cockroachdb-public
  - name: CHATBASE_PORT
    value: "26257"
  - name: CHATBASE_USER
    value: root
  - name: BOTSERVER_URL
    value: http://botserver/synthetic
  - name: DRY_RUN
    value: "false"
  - name: EXODUS_RATE_LIMIT
    value: "1s"
  - name: EXODUS_MAX_BAIL_USERS
    value: "100000"

executor:
  enabled: true
  schedule: "* * * * *"
  concurrencyPolicy: Forbid
  activeDeadlineSeconds: 3600
  resources:
    requests: { cpu: 50m, memory: 128Mi }
    limits: { cpu: 500m, memory: 512Mi }

api:
  enabled: false  # "Enable when UI is ready"
  replicas: 1
  port: 8080
  resources:
    requests: { cpu: 50m, memory: 64Mi }
    limits: { cpu: 200m, memory: 256Mi }
  service:
    type: ClusterIP
    port: 80
```

### Template Details

**CronJob** (`cronjob.yaml`):
- Gated by `executor.enabled`
- Sets `args: ["--mode=executor"]`
- Injects `env` list from `.Values.env`
- Uses `restartPolicy: OnFailure`

**Deployment** (`deployment.yaml`):
- Gated by `api.enabled`
- Sets `args: ["--mode=api"]`
- Injects `env` list from `.Values.env` PLUS adds `PORT` from `.Values.api.port`
- Has liveness and readiness probes on `/health` (initial delay 5s, period 10s)

**Service** (`service.yaml`):
- Gated by `api.enabled`
- ClusterIP, port 80 -> targetPort http (8080)

### Parent Chart Integration

File: `/home/nandan/Documents/vlab-research/fly/devops/vlab/Chart.yaml` (line 47-49)

Exodus is listed as a dependency of the parent `vlab` chart:
```yaml
- name: exodus
  version: 0.1.0
  repository: oci://us-west1-docker.pkg.dev/toixotoixo/vlab-research/charts
```

Note: exodus has **no conditional tag** (unlike most other charts which have tags like `tags: [dean]`). This means it is **always deployed** when the parent chart is installed.

### Parent Default Values

File: `/home/nandan/Documents/vlab-research/fly/devops/vlab/values.yaml` (line 10-12)

```yaml
exodus:
  api:
    enabled: true
```

This overrides the chart default (`api.enabled: false`) to enable the API deployment.

## Production Values Analysis

File: `/home/nandan/Documents/vlab-research/fly/devops/values/production.yaml`

**Exodus is NOT configured in production.yaml at all.** There is no `exodus:` section anywhere in the file.

This means production uses:
1. The chart's default `values.yaml` for most settings
2. The parent chart's `values.yaml` override for `api.enabled: true`

### What This Means for Production

With no production overrides, exodus deploys with these effective values:

| Setting | Value | Source | Concern |
|---------|-------|--------|---------|
| `image.tag` | `latest` | chart default | **PROBLEM**: No pinned version; inconsistent with other services |
| `CHATBASE_HOST` | `cockroachdb-public` | chart default | **PROBLEM**: Production uses `gbv-cockroachdb-public` |
| `CHATBASE_USER` | `root` | chart default | **PROBLEM**: Production uses `chatroach` user |
| `CHATBASE_PASSWORD` | (empty) | chart default | May be correct if CockroachDB has no auth, but other services set it explicitly |
| `BOTSERVER_URL` | `http://botserver/synthetic` | chart default | **PROBLEM**: Production uses `http://gbv-botserver/synthetic` |
| `DRY_RUN` | `false` | chart default | OK |
| `EXODUS_RATE_LIMIT` | `1s` | chart default | OK |
| `EXODUS_MAX_BAIL_USERS` | `100000` | chart default | OK |
| `executor.enabled` | `true` | chart default | OK |
| `api.enabled` | `true` | parent values.yaml | OK |

### Critical Gaps in Production Config

Comparing to how other services are configured in production.yaml:

1. **No image version pin** -- Every other service has a pinned version tag (e.g., `versionDean: &vdean v0.0.38`). Exodus uses `latest`.

2. **Wrong database host** -- Other services use `*host` which resolves to `gbv-cockroachdb-public`. Exodus chart default is `cockroachdb-public`.

3. **Wrong database user** -- Other services use `chatroach` user. Exodus chart default is `root`.

4. **Wrong botserver URL** -- Other services use `http://gbv-botserver/synthetic`. Exodus chart default is `http://botserver/synthetic`.

5. **No CHATBASE_PORT override** -- Chart default is `26257`, which happens to match production. This is fine.

### What production.yaml SHOULD Have

Based on patterns from other services (dean, dinersclub, scribble):

```yaml
versionExodus: &vexodus v0.1.0  # or whatever the current version is

exodus:
  image:
    tag: *vexodus
  env:
    - name: CHATBASE_DATABASE
      value: "chatroach"
    - name: CHATBASE_HOST
      value: *host  # gbv-cockroachdb-public
    - name: CHATBASE_PORT
      value: "26257"
    - name: CHATBASE_USER
      value: "chatroach"
    - name: CHATBASE_PASSWORD
      value: ""
    - name: BOTSERVER_URL
      value: "http://gbv-botserver/synthetic"
    - name: DRY_RUN
      value: "false"
    - name: EXODUS_RATE_LIMIT
      value: "1s"
    - name: EXODUS_MAX_BAIL_USERS
      value: "100000"
  api:
    enabled: true
  executor:
    enabled: true
```

## Database Schema

File: `/home/nandan/Documents/vlab-research/fly/devops/migrations/06-exodus-bails.sql`

Two tables in `chatroach` schema:
- `chatroach.bails` -- bail configurations (user-scoped, JSONB definition)
- `chatroach.bail_events` -- execution audit trail (immutable insert-only)

Note: The migration does NOT include the `source_shortcodes` column. The bails-cross-survey refactoring plan (`planning/bails-cross-survey-plan.md`) intended to add `source_shortcodes STRING[]` but the current migration at line 37 shows it was NOT included. The Go code in `db/bails.go` also does not reference `source_shortcodes` in its SQL queries. However, the README and types documentation mention it extensively. This appears to be planned but not yet implemented -- the README describes the target architecture.

## Existing Documentation

| File | Content |
|------|---------|
| `/home/nandan/Documents/vlab-research/fly/exodus/README.md` | Comprehensive service README (architecture, config, API, query DSL, executor flow, deployment). Describes target architecture with source_shortcodes. |
| `/home/nandan/Documents/vlab-research/fly/documentation/bail-systems.md` | Cross-component documentation of the bail system (data flow, model, access control, execution model). |
| `/home/nandan/Documents/vlab-research/fly/documentation/chat-message-logging.md` | References exodus briefly as a source of synthetic events. |
| `/home/nandan/Documents/vlab-research/fly/planning/bails-cross-survey-plan.md` | Implementation plan for user-scoped refactoring (may be partially complete). |
| `/home/nandan/Documents/vlab-research/fly/exodus/EXODUS_UI_IMPLEMENTATION_PLAN.md` | UI implementation plan for dashboard integration. |
| `/home/nandan/Documents/vlab-research/fly/exodus/EXODUS_UI_FEEDBACK.md` | UI feedback notes. |

## Summary of Key Issues

1. **Production config is missing entirely** -- exodus will deploy with chart defaults that point to wrong service names (`cockroachdb-public` vs `gbv-cockroachdb-public`, `botserver` vs `gbv-botserver`, `root` user vs `chatroach`).

2. **No version pinning** -- using `latest` tag is a deployment risk.

3. **source_shortcodes gap** -- The README and documentation describe source_shortcodes as a feature, but the current migration and Go code do not include it. The code at `query/builder.go` does NOT include a source_shortcodes JOIN (it does not call or reference source_shortcodes at all). The `db/bails.go` CRUD operations do not read or write source_shortcodes. This is a documentation-code mismatch.

4. **Rate limiting env var naming** -- `documentation/bail-systems.md` line 253 references `BAILER_RATE_LIMIT` but the actual env var is `EXODUS_RATE_LIMIT` (per config.go). Minor documentation bug.

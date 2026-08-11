# Helm Chart Structure Findings

**Date**: 2026-02-15
**Scope**: `devops/vlab/` umbrella chart, subchart patterns, exodus integration

---

## 1. Overall Architecture

The deployment uses an **umbrella chart** pattern:

- **Umbrella chart**: `devops/vlab/` (name: `vlab`, version: `0.0.1`)
- **Subcharts**: Each service has its own Helm chart, packaged as `.tgz` in `devops/vlab/charts/`
- **Chart source**: Each service keeps its chart source at `<service>/chart/` within the monorepo (e.g., `dinersclub/chart/`, `exodus/chart/`)
- **Chart registry**: OCI registry at `oci://us-west1-docker.pkg.dev/toixotoixo/vlab-research/charts` (some legacy charts at `https://vlab-research.github.io/fly`)

### Dependency Declaration (`devops/vlab/Chart.yaml`)

All 16 subcharts are declared as dependencies. Most custom services use OCI registry. Some have `tags:` for conditional inclusion, some do not (notably `replybot`, `botserver`, `linksniffer`, `dashboard`, `formcentral`, and **`exodus`** have NO tags -- they are always included).

### Values Layering

1. **Subchart defaults**: `<service>/chart/values.yaml` (baked into `.tgz`)
2. **Umbrella defaults**: `devops/vlab/values.yaml` (nearly empty -- only sets `cockroachdb.enabled: true`, `kafka.enabled: true`, `exodus.api.enabled: true`)
3. **Environment overrides**: `devops/values/production.yaml` (the main config file)

Deploy command is presumably: `helm upgrade gbv devops/vlab/ -f devops/values/production.yaml`

---

## 2. Production Values Structure (`devops/values/production.yaml`)

### Global Anchors (YAML Anchors)

Production values define shared anchors at the top level:
```yaml
kafkabrokers: &kb "kafka-headless.default.svc.cluster.local:29092"
chatTopic: &topic "vlab-prod-chat-events"
stateTopic: &statetopic "vlab-prod-state"
responseTopic: &responsetopic "vlab-prod-response"
paymentTopic: &paymenttopic "vlab-prod-payment"
botEnvs: &botenvs gbv-bot-envs
chatbaseHost: &host "gbv-cockroachdb-public"
exporterTopic: &exportertopic "vlab-exports"
```

These anchors are referenced (`*kb`, `*host`, etc.) throughout the per-service `env:` blocks.

### Version Anchors

Each service has a version anchor: `versionDinersclub: &vdinersclub v0.0.38`, used as `tag: *vdinersclub`.

### Tag Flags

```yaml
tags:
  kafka: false    # Uses external Kafka
  backup: true
  cockroach: true
  redis: true
  naughtybot: false
  botscribe: false
  scratchbot: false
  scribble: true
  dean: true
```

**Key observation**: There are no `exodus` or `exporter` tags. Since these charts have no `tags:` condition in Chart.yaml and no `condition:` field, they are **always deployed**.

---

## 3. Env Var Pattern in Templates

All custom service subcharts follow the same pattern for environment variables:

### Pattern A: Simple Deployment (dinersclub, linksniffer, formcentral, replybot, botserver)

The template uses `{{- toYaml .Values.env | nindent N }}` to render the entire `env:` array from values.

**Template** (`dinersclub/templates/deployment.yaml` lines 33-34):
```yaml
          env:
            {{- toYaml .Values.env | nindent 12 }}
```

**Values** (in `production.yaml` under `dinersclub:`):
```yaml
dinersclub:
  env:
    - name: CHATBASE_HOST
      value: *host
    - name: KAFKA_BROKERS
      value: *kb
    # ... all env vars listed explicitly
```

Some services also support `envFrom` for Kubernetes secrets:
```yaml
          envFrom:
          - secretRef:
              name: "{{ .Values.envFrom }}"
```

### Pattern B: Ranged Deployments (scribble, dean)

These iterate over a list to create multiple Deployments/CronJobs:

**Scribble** -- ranges over `.Values.sinks`, each sink creates a Deployment. Global env vars are merged with per-sink env vars:
```yaml
{{- range .Values.sinks }}
# ...
          env:
            {{- toYaml $.Values.env | nindent 12 }}       # shared env
            - name: SCRIBBLE_DESTINATION
              value: {{ .destination }}
            {{- toYaml .env | nindent 12 }}                # per-sink env
```

**Dean** -- ranges over `.Values.queries`, each query creates a CronJob. Global env vars merged with per-query env vars:
```yaml
{{- range .Values.queries }}
# ...
              env:
                {{- toYaml $.Values.env | nindent 16 }}     # shared env
                - name: DEAN_QUERIES
                  value: {{ .queries }}                      # per-job env
```

### Pattern C: Secret-backed env (exporter)

Uses `envSecrets` list to mount multiple Kubernetes Secrets as envFrom:
```yaml
          envFrom:
          {{- range .Values.envSecrets }}
          - secretRef:
              name: {{ . | quote }}
          {{- end }}
```

---

## 4. Exodus Subchart Details

### Source Location

`/home/nandan/Documents/vlab-research/fly/exodus/chart/`

### Packaged Chart

`devops/vlab/charts/exodus-0.1.0.tgz` -- already built and present in the charts directory.

### Templates

The exodus chart has **three template files** (more complex than most services):

| Template | Kind | Condition | Purpose |
|----------|------|-----------|---------|
| `deployment.yaml` | Deployment | `.Values.api.enabled` | REST API server |
| `cronjob.yaml` | CronJob | `.Values.executor.enabled` | Bail executor (runs every minute) |
| `service.yaml` | Service | `.Values.api.enabled` | ClusterIP service for API |

### Env Var Handling

Both deployment and cronjob render env vars identically:
```yaml
          env:
            {{- toYaml .Values.env | nindent N }}
```

The API deployment also injects `PORT` from `.Values.api.port`.

### Default Values (`exodus/chart/values.yaml`)

```yaml
env:
  - name: CHATBASE_DATABASE
    value: chatroach
  - name: CHATBASE_HOST
    value: cockroachdb-public           # NOT using production anchor
  - name: CHATBASE_PORT
    value: "26257"
  - name: CHATBASE_USER
    value: root                          # Different from other services (chatroach)
  - name: BOTSERVER_URL
    value: http://botserver/synthetic    # NOT using release-prefixed name
  - name: DRY_RUN
    value: "false"
  - name: EXODUS_RATE_LIMIT
    value: "1s"
  - name: EXODUS_MAX_BAIL_USERS
    value: "100000"

executor:
  enabled: true
  schedule: "* * * * *"

api:
  enabled: false
```

### Current Umbrella Override (`devops/vlab/values.yaml`)

```yaml
exodus:
  api:
    enabled: true
```

### Production Override

**NONE** -- there is no `exodus:` section in `devops/values/production.yaml`. This means production would use the subchart defaults with only `api.enabled: true` from the umbrella values.

---

## 5. Critical Issues / Gaps

### 5.1 Exodus Missing from Production Values

Exodus has NO production overrides. Compared to every other service that specifies:
- `image.repository` and `image.tag` with version anchor
- `env:` with production-specific values using YAML anchors (`*host`, `*kb`, etc.)
- `resources:` requests

Exodus would deploy with **subchart defaults**, which have wrong values for production:
- `CHATBASE_HOST: cockroachdb-public` should be `gbv-cockroachdb-public`
- `CHATBASE_USER: root` should be `chatroach`
- `BOTSERVER_URL: http://botserver/synthetic` should be `http://gbv-botserver/synthetic`
- `image.tag: latest` -- no pinned version
- No version anchor defined (no `versionExodus`)

### 5.2 Exodus Has No Tag Guard

Unlike dean, scribble, dumper, etc., exodus has no `tags:` in Chart.yaml. It is **always included** as a dependency. The executor is enabled by default. This means it will run in production without proper env var configuration.

### 5.3 No `envFrom` Support

Exodus templates do not support `envFrom` (Kubernetes secret references). Some services like dinersclub and replybot use this for sensitive credentials via `envFrom: gbv-bot-envs`. If exodus needs secrets, the template would need modification.

---

## 6. Pattern Summary for Adding/Configuring a Service

To properly integrate a service (like exodus) into production, follow this pattern:

### In `devops/values/production.yaml`:

```yaml
versionExodus: &vexodus v0.1.0     # Add version anchor at top

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
    - name: CHATBASE_HOST
      value: *host                   # Uses shared anchor
    - name: CHATBASE_PORT
      value: "26257"
    - name: BOTSERVER_URL
      value: "http://gbv-botserver/synthetic"
    - name: DRY_RUN
      value: "false"
    # ... service-specific env vars
  executor:
    enabled: true
    schedule: "* * * * *"
  api:
    enabled: true                    # or false if not ready
```

### Key conventions:
1. All env vars are explicit `name:` / `value:` pairs in a YAML list
2. Shared infrastructure values use YAML anchors (`*host`, `*kb`)
3. Version tags use anchors defined at top level
4. `resources.requests` are specified for each service
5. Database host is `gbv-cockroachdb-public` (release-prefixed)
6. Database user is `chatroach` (not `root`)
7. Botserver URL is `http://gbv-botserver/synthetic` (release-prefixed)

---

## 7. File Reference Index

| File | Purpose |
|------|---------|
| `/home/nandan/Documents/vlab-research/fly/devops/vlab/Chart.yaml` | Umbrella chart with all dependency declarations |
| `/home/nandan/Documents/vlab-research/fly/devops/vlab/Chart.lock` | Locked dependency versions |
| `/home/nandan/Documents/vlab-research/fly/devops/vlab/values.yaml` | Umbrella default values (minimal) |
| `/home/nandan/Documents/vlab-research/fly/devops/values/production.yaml` | Production environment overrides (main config) |
| `/home/nandan/Documents/vlab-research/fly/devops/vlab/templates/topics.yaml` | KafkaTopic CRDs |
| `/home/nandan/Documents/vlab-research/fly/devops/vlab/templates/lagging-alerts.yaml` | Prometheus lagging consumer alerts |
| `/home/nandan/Documents/vlab-research/fly/devops/vlab/templates/processing-alerts.yaml` | Prometheus processing alerts |
| `/home/nandan/Documents/vlab-research/fly/devops/vlab/charts/exodus-0.1.0.tgz` | Packaged exodus subchart |
| `/home/nandan/Documents/vlab-research/fly/exodus/chart/` | Exodus subchart source |
| `/home/nandan/Documents/vlab-research/fly/exodus/chart/templates/deployment.yaml` | Exodus API deployment template |
| `/home/nandan/Documents/vlab-research/fly/exodus/chart/templates/cronjob.yaml` | Exodus executor CronJob template |
| `/home/nandan/Documents/vlab-research/fly/exodus/chart/templates/service.yaml` | Exodus API service template |

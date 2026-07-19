# Staging Tagging & Deployment for WhatsApp Platform Work

## Purpose & Rationale

This document describes the tagging and deployment strategy for the platform abstraction WhatsApp work on branch `feature/platform-abstraction`. 

We are shifting message-sending responsibility from replybot (Node) to a new Go `message-worker` service. This work must **stay in staging only** until WhatsApp is production-ready. To prevent accidental promotion to production, **all image tags for this work carry a `-wa` suffix** (e.g., `replybot-v0.0.205-wa`, `message-worker-v0.1.11-wa`).

A `-wa` tag appearing in `devops/values/production.yaml` is an immediate red flag during code review — the suffix is the primary guardrail preventing premature prod deployment. Kubernetes namespace isolation (`vstag` vs `vprod`) and per-environment values files provide layered protection, but the tag suffix is the first line of defense.

---

## Tag Scheme & CI

### Git Tag Format

```
{service}-v{X.Y.Z}-wa
```

Examples:
- `message-worker-v0.1.11-wa`
- `replybot-v0.0.205-wa`

### CI Parsing (.github/workflows/release.yml)

The release workflow parses the tag to extract service name and version:

```bash
SERVICE="${TAG%-v*}"
VERSION="v${TAG##*-v}"
```

These patterns **preserve the suffix**, so a tag like `replybot-v0.0.205-wa` yields:
- `SERVICE=replybot`
- `VERSION=v0.0.205-wa`

The Docker image built and pushed to GHCR is: `ghcr.io/vlab-research/replybot:v0.0.205-wa`

### GitHub Actions Tag Triggers

`.github/workflows/release.yml` (lines 4–6) has two patterns in `on: push: tags:`:

```yaml
tags:
  - '*-v[0-9]+.[0-9]+.[0-9]+'        # Normal releases (e.g., replybot-v0.0.205)
  - '*-v[0-9]+.[0-9]+.[0-9]+-*'      # Suffixed releases (e.g., replybot-v0.0.205-wa)
```

- **First pattern** matches unsuffixed tags for normal releases.
- **Second pattern** matches any tag with a suffix (anything after the patch number), enabling `-wa` and future staging-only tags to trigger builds.

Both patterns are **full-string anchored globs**, so trailing characters must match explicitly. Without the second pattern, `-wa` tags would silently fail to trigger the build workflow.

---

## Deploy to Staging: Safe Runbook

### 1. Identify Changed Services

The feature branch (`feature/platform-abstraction`) modifies **ONLY** replybot and message-worker. Verify:

```bash
git diff --stat main...feature/platform-abstraction | grep -E "^(.*replybot|.*message-worker)" | head -20
```

Output shows changes only to:
- `replybot/lib/` (event normalization, platform abstraction)
- `message-worker/` (new Go service)
- `devops/values/production.yaml` and `devops/values/staging.yaml` (version bumps for these two services)

All other services remain untouched.

### 2. Tag the Branch HEAD & Push

Tag the feature branch commit that includes the release.yml trigger change:

```bash
# On feature/platform-abstraction branch at the right commit
git tag replybot-v0.0.205-wa
git tag message-worker-v0.1.11-wa
git push origin replybot-v0.0.205-wa message-worker-v0.1.11-wa
```

CI builds and pushes both images to GHCR with the `-wa` suffix.

### 3. Deploy to Staging from the Repo Values File

**Policy (since the 2026-07-19 reconciliation):** `devops/values/staging.yaml` on this branch IS the source of truth for staging and can be deployed directly. It was reconciled with the live cluster (`helm get values gbv -n vstag`): the only drift was image tags — `dinersclub` (→ `v0.0.41-wa`) and `message-worker` (→ `v0.1.12-wa`) were stale in the repo and have been corrected; `exporter` intentionally stays at `v0.6.9` (prod parity — staging live was behind at `v0.6.7`, so the next deploy catches it up). Non-image config had zero drift.

**Before any future wholesale deploy, re-check drift first** — if the file has drifted again, reconcile it before deploying:

```bash
helm get values gbv -n vstag > staging-live-values.yaml
# compare image tags against the version* anchors in devops/values/staging.yaml
```

Deploy:

```bash
helm upgrade gbv /path/to/devops/vlab \
  -f devops/values/staging.yaml \
  -n vstag
```

**Alternative — minimal single-service roll:** if you deliberately want to touch only one service (e.g. avoid rolling exporter during an unrelated test), keep using the old live-patch path: `helm get values gbv -n vstag > staging-live-values.yaml`, edit just that service's `image.tag`, and `helm upgrade -f staging-live-values.yaml`.

### 4. Verify Deployment

Message-worker was already running in staging (`vstag` namespace) before this deploy — the Kafka topics (`vlab-staging-commands`) and shared credentials token table are already live. This is a rolling update of two services; no infrastructure changes are needed.

Verify:
```bash
kubectl get pod -n vstag -l app.kubernetes.io/name=message-worker -w
kubectl logs -n vstag -l app.kubernetes.io/name=message-worker -f
```

See `documentation/message-worker-deployment.md` for deployment prerequisites and validation steps.

---

## Guardrails & Prohibitions

### NEVER Deploy `-wa` Tags to Production

1. **Do not add** any `-wa` tag to `devops/values/production.yaml`.
2. **Do not deploy** the feature branch to production namespace (`vprod`) while it carries `-wa` tags.
3. **Do not** submit a PR with `-wa` tags in `devops/values/production.yaml` — this will be caught in code review.

### Namespace & Values File Isolation

- **Staging:** `vstag` namespace, `devops/values/staging.yaml`
- **Production:** `vprod` namespace, `devops/values/production.yaml`

A `-wa` tag appearing in the production values file is suspicious and must be investigated.

### Promotion to Production

When the WhatsApp work is ready for production:

1. **Rebuild without the suffix**: Create new unsuffixed tags (e.g., `replybot-v0.0.205`, `message-worker-v0.1.11`) from the same commit or a new commit.
2. **Update production.yaml** with the unsuffixed tags.
3. **Deploy to production** using the normal release process.

The `-wa` suffix was **temporary**; production images must never carry it.

---

## Cross-Links

- **`documentation/platform-abstraction.md`** — Architecture overview, inbound/outbound normalization, remaining P0-P2 WhatsApp work, and why the core state machine is platform-agnostic.
- **`documentation/message-worker-deployment.md`** — Deployment prerequisites, coordinated replybot/message-worker deployment, Kafka topics, environment variables, health checks, and token store compatibility.

---

## Summary

The `-wa` suffix ensures WhatsApp-track code stays in staging:

1. Tag with `-wa` suffix: `{service}-v{X.Y.Z}-wa`
2. CI builds images with the suffix preserved: `ghcr.io/vlab-research/{service}:{version}-wa`
3. Deploy only to `vstag` namespace using live staging values, patching only the two changed services
4. Never add `-wa` tags to `devops/values/production.yaml`
5. When promoting to prod, rebuild with unsuffixed tags

This approach provides a clear, reviewable, unambiguous signal that work is staging-only, without relying on CI gates (which don't exist) or implicit operator discipline.

# GitOps CD: Version-tracked deploys for backend (Helm) + frontend (Netlify)

**Status:** Planned, not started.
**Author context:** Written 2026-07-25 during the WhatsApp platform rollout, after realizing the deploy story is inconsistent and partly un-tracked.
**Owner:** unassigned — this doc is a handoff for a future agent/engineer.

---

## 1. Why this exists (the problem)

Two gaps in how we ship, discovered while planning the WhatsApp frontend/backend cutover:

### Gap 1 — Backend build is automated, but backend *deploy* is not
- `.github/workflows/release.yml` turns a git tag `<service>-v<semver>[-suffix]` into a GHCR image (`ghcr.io/vlab-research/<img>:<version>`). That's the whole workflow — it **builds and stops**.
- The actual deploy — `helm upgrade gbv vlab -f values/staging.yaml -n vstag` — is run **manually from a laptop** against the live GKE cluster. Kubeconfig is local.
- `devops/values/{staging,production}.yaml` is the *only* declaration of "which version runs where," yet it is edited locally and (per the maintainer) **not always committed/pushed**. So declared desired state and actual cluster state are kept in sync only by human memory. This is the core mess.

### Gap 2 — Frontend deploys on a completely different model
- The `dashboard-client` (React/CRA) is hosted on **Netlify**, deployed by **git branch push**, not tags:
  - Netlify site `vlab-research` (ID `57803b4c-bd0a-4650-985e-e24f8c496bb0`), Starter plan.
  - Production branch `main` → `fly.vlab.digital` (Netlify `context.production`).
  - Staging branch `staging` → `staging--vlab-research.netlify.app` (Netlify `context.staging`).
  - Env vars per environment live in `dashboard-client/netlify.toml` context blocks.
- Consequences: push == deploy; **`main` is a live deploy trigger**; there is no versioned frontend artifact, no rollback target, and no separation of "built" from "released." This is why merging `feature/whatsapp-platform-keying` to main is currently blocked — merging *is* shipping the prod client against an un-upgraded prod server + un-migrated prod DB.

**Goal:** one consistent, version-tracked, git-driven deploy model for the whole system, where `devops/values/*.yaml` is the single declarative manifest of "what version of everything runs in each environment" — **backend image tags *and* the frontend version** — and pushing that file is what deploys.

---

## 2. Decisions already made (do not re-litigate)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Push-based CD** (GitHub Actions runs `helm` + Netlify CLI), **not** pull-based (Argo CD / Flux). | Push is the smallest step from today (relocates the laptop `helm upgrade` into CI) and is the **only** model that can drive both K8s *and* Netlify from one values-file push. Argo can't deploy Netlify (outside the cluster) and can't gate on a DB migration, which would leave the frontend on a separate model — defeating the "same file" goal. Revisit Argo only if live-drift correction becomes a real need. |
| D2 | **`devops/values/*.yaml` is the single source of truth**, extended to carry the frontend version alongside backend image tags. | The file already lists every service as `versionX: &anchor vX.Y.Z`. Adding `versionDashboardClient` is a one-line, idiomatic addition. One reviewable diff ships server + client together. |
| D3 | **Prefer Workload Identity Federation (keyless)** for the CI→GKE credential over a long-lived service-account JSON key. | No long-lived secret in GitHub; scope to `vstag`/`vprod` only. |
| D4 | **Staging pipeline first, then prod.** | Staging is safe to iterate on and proves the "helm + Netlify in one workflow" shape end-to-end. Prod is a copy + the migration gate + tighter guardrails. |
| D5 | Trigger model: **staging deploys on push to the `staging` branch** touching `values/staging.yaml`; **prod deploys on push to `main`** touching `values/production.yaml`. | Preserves the existing "validate on staging before merging to main" flow. |

### The one design fork already resolved
Push vs. pull → **push** (D1). No open architectural questions remain; what's left is implementation + credential provisioning + the guardrails in §5.

---

## 3. Target architecture

```
 developer edits devops/values/<env>.yaml  (bumps versionReplybot, versionDashboardClient, ...)
        │  git push  (staging branch → staging ;  main → prod)
        ▼
 GitHub Actions  cd-<env>.yml
        ├─ auth to GKE (Workload Identity Federation)
        ├─ helm upgrade gbv vlab -f values/<env>.yaml -n <ns>      ← backend (reads versionX anchors)
        │     (+ optional rollout restart for env-only changes)
        └─ read versionDashboardClient  →  build CRA at that tag  →  netlify deploy  ← frontend
```

- **One manifest** (`values/<env>.yaml`) declares every version. **One push** deploys everything for that env. `main` stops being an *implicit* deploy trigger and becomes an *explicit, reviewed* one via the values diff.
- This also delivers the coordinated frontend+backend rollout the WhatsApp cutover needs: one `production.yaml` bump ships the new server AND the matching client together.

### Frontend version in the values file
`release.yml`'s tag scheme is reused: add `dashboard-client` as a recognized service so a `dashboard-client-v<semver>` tag produces an immutable, versioned CRA build artifact (see Phase 2). Then the env is pinned declaratively:

```yaml
# devops/values/staging.yaml  (and production.yaml)
versionDashboardClient: &vdashboardclient v1.2.0
```

The CD workflow reads that value and deploys exactly that version to Netlify — so the frontend gets the same "immutable versioned artifact + git-declared placement" story the backend images have. Rollback = revert the values line (re-deploy prior tag).

---

## 4. Implementation phases

### Phase 0 — Prerequisites (human, one-time)
- [ ] **Commit the current values files.** Reconcile `devops/values/{staging,production}.yaml` in git with what is actually live in `vstag`/`vprod` *before* automation starts, or the first CD run will deploy a stale/wrong state. Diff git vs. live (`helm get values gbv -n vstag` / `-n vprod`) and commit the truth.
- [ ] Provision **Workload Identity Federation** GKE deployer, scoped to `vstag` + `vprod` namespaces only (get/list/patch on deployments, secrets as needed for helm). Record the provider + service-account resource names.
- [ ] Create a **Netlify personal access token**; add as GitHub secret `NETLIFY_AUTH_TOKEN`. Site ID `57803b4c-bd0a-4650-985e-e24f8c496bb0` can be a repo var `NETLIFY_SITE_ID` (or two IDs if D-alt two-site option is chosen — see §6).
- [ ] Decide staging Netlify representation: keep the single-site branch-context model, or move staging to a CLI deploy. Interim: **leave staging on branch-auto-deploy** and wire only the helm half of staging CD first, to de-risk.

### Phase 1 — Staging backend CD (helm from CI)
- [ ] Add `.github/workflows/cd-staging.yml`: `on: push` to branch `staging`, `paths: [devops/values/staging.yaml, devops/vlab/**]`.
- [ ] Steps: checkout → auth GKE (WIF) → `helm upgrade gbv vlab -f devops/values/staging.yaml -n vstag` → optional `kubectl rollout status`.
- [ ] Verify against a no-op bump, then a real service bump. Confirm parity with the manual command in `documentation/staging.md`.
- [ ] Keep the manual command documented as the break-glass fallback.

### Phase 2 — Frontend versioned artifact + staging frontend CD
- [ ] Extend `release.yml` (or a sibling) so a `dashboard-client-v<semver>[-suffix]` tag builds the CRA bundle and stores an immutable artifact (options: Netlify deploy with an immutable deploy-id/alias per tag, or an uploaded build artifact). Reuse the existing tag `Parse tag` step.
- [ ] Add `versionDashboardClient` anchor to `values/staging.yaml`.
- [ ] Extend `cd-staging.yml` to read `versionDashboardClient` and `netlify deploy` that version to the staging site/context. Confirm `context.staging` env vars still apply under a CLI deploy (this is the fiddly bit — see §6).
- [ ] Turn **off** Netlify auto-build-on-push for staging once CLI deploy is trusted (avoid double deploys).

### Phase 3 — Production CD (copy staging + gates)
- [ ] Add `.github/workflows/cd-prod.yml`: `on: push` to `main`, `paths: [devops/values/production.yaml, devops/vlab/**]`.
- [ ] Add the **guardrail CI check** (§5): fail if any prod version carries a pre-release suffix (e.g. `-wa`, `-rc`, `-staging`).
- [ ] Add the **migration gate** (§5): prod releases requiring DB migrations must run migrations *before* helm, or be gated behind `workflow_dispatch` while routine releases auto-run.
- [ ] Wire the prod Netlify deploy (`--prod`, reads `versionDashboardClient` from `production.yaml`).
- [ ] Turn off Netlify auto-build from `main`. **`main` is now merge-only, not a deploy trigger** — this unblocks merging feature branches freely.

### Phase 4 — Cutover & cleanup
- [ ] Update `documentation/staging.md` + a new `documentation/deployment.md` describing the GitOps model, the trigger paths, the guardrails, and break-glass.
- [ ] Retire ad-hoc deploy notes that describe the laptop workflow as the primary path.

---

## 5. Guardrails & risks (build these in, don't bolt on)

- **The PR becomes the production gate.** Under auto-deploy a merged bad values line ships instantly. The existing rule "**never put `-wa` (or any pre-release) tags in `production.yaml`**" stops being a note-to-self and becomes load-bearing. → **CI check** in `cd-prod.yml` that fails the run if any `version*` value in `production.yaml` matches `-<suffix>` after the semver. This is the single most important safety addition.
- **Migration-gated releases.** Some prod cutovers (e.g. WhatsApp needs migrations 20–22 before helm — see `planning/staging-rollout-runbook.md`) must not let helm run first. → migration step ordered before helm, or `workflow_dispatch` for those releases.
- **No live drift-correction** (the accepted cost of push over pull). If someone `kubectl edit`s live, CI won't notice until the next push. Acceptable for current team size; Argo (D1) is the future answer if this bites.
- **CI holds cluster credentials.** Scope WIF to the two namespaces; no cluster-admin. Access tokens / secrets must never be logged.
- **Netlify context env vars under CLI deploy.** `context.production.environment` / `context.staging.environment` in `dashboard-client/netlify.toml` are applied by Netlify's build contexts. Confirm they still resolve when deploying via `netlify deploy --prod` / staging from CI, or move those env vars into the workflow / Netlify site settings. Validate on staging before prod.

---

## 6. Open sub-decision for the implementer (Netlify env representation)

Not blocking, but choose during Phase 2:
- **(A) One Netlify site (current), prod via `--prod` + staging via deploy alias/context.** Cheapest; staging rides an alias URL; getting `context.staging` env to apply under CLI is the fiddly part.
- **(B) Two Netlify sites (dedicated staging + prod), each CLI-deployed.** Cleaner separation (true analog of `vstag` vs `vprod`), each env's vars in its own site; needs a second site + second `NETLIFY_SITE_ID`. Recommended if (A)'s context handling proves painful.

Interim default: keep staging on branch-auto-deploy (no token needed) and convert it to tags in a fast follow, so Phase 1 (helm) can land without waiting on this.

---

## 7. Key repo facts (grounding for the implementer)

- Tag format & image build: `.github/workflows/release.yml` (`<service>-v<semver>[-suffix]` → `ghcr.io/vlab-research/<img>:<version>`; has a `case` service→context/image map — **add `dashboard-client` there** for Phase 2).
- Values files: `devops/values/staging.yaml`, `devops/values/production.yaml` — services declared as `versionX: &anchor vX.Y.Z` (YAML anchors).
- Helm: chart `devops/vlab`, release name `gbv`; namespaces `vstag` (staging) / `vprod` (production), same GKE cluster.
- Manual deploy today (the thing being automated), from `documentation/staging.md`:
  ```
  cd devops && bash accounts.sh vstag ../replybot/.env-staging   # secret refresh (separate concern)
  cd devops && helm upgrade gbv vlab -f values/staging.yaml -n vstag
  kubectl rollout restart deployment/gbv-... -n vstag
  ```
- Netlify: site `vlab-research` / ID `57803b4c-bd0a-4650-985e-e24f8c496bb0`; prod branch `main`→`fly.vlab.digital`; staging branch `staging`→`staging--vlab-research.netlify.app`; env in `dashboard-client/netlify.toml` (`context.production` / `context.staging`); build base `dashboard-client/`, cmd `npm run build`, publish `dashboard-client/build/`. Starter plan (no branch subdomains).
- Related docs: `documentation/staging.md` (env map, Auth0, deploy steps), `planning/staging-rollout-runbook.md` (migration-gated prod cutover example), `planning/whatsapp-plan.md` (why the coordinated FE+BE rollout matters).

---

## 8. First concrete step for whoever picks this up

Start **Phase 0 + Phase 1**: reconcile & commit the live values files, provision WIF, then write `cd-staging.yml` doing *only* the helm half. Prove it with a no-op staging bump before touching Netlify or prod. Everything else copies from there.

# Release Lineages: Staging and Production Are Separate Lines

## Purpose

Replybot version tags are **not a single linear progression**. Staging and
production are separate lineages, and a *higher-numbered* production tag can
legitimately lack code that a *lower-numbered* staging tag contains.

This trips up anyone auditing branches or tags — it reads as a downgrade or a
lost fix when it is neither. This document exists so that discovery does not
have to be repeated.

## The Model

- **`staging` is the integration branch for staging** (since 2026-07-25).
  Feature branches merge into `staging`; it is what the `vstag` namespace and
  the staging Netlify sites are built from. It is merged into, never rebased.
- **Production runs its own, older line.** It is not simply "an earlier commit
  on the integration branch" — production hotfixes are cherry-picked onto the
  production baseline rather than taken from the staging line.
- Consequently a production tag is `production baseline + cherry-picked fixes`,
  and may not contain staging-only work regardless of its version number.

### Historical note

Before 2026-07-25 the `staging` branch was unused (75 commits stale) and `main`
served as the de-facto staging accumulator, while Netlify simultaneously
treated `main` as *production* for the frontend. Those two facts contradicted
each other. Consolidating onto `staging` resolves it.

> **Unresolved:** `main`'s role after this cutover has not been settled. Netlify
> still builds the production frontend from `main` (see
> `documentation/staging.md`), but `main` also still carries un-promoted backend
> work. Decide and record whether `main` becomes the production line or remains
> a trunk that `staging` merges from. Until that is settled, do not infer
> `main`'s meaning from this document.

## Branch → Environment

| Branch | Frontend (Netlify) | Backend (k8s) |
|---|---|---|
| `staging` | `staging--vlab-research.netlify.app`, `staging--virtuallab-videos.netlify.app` | `vstag`, via image tags in `devops/values/staging.yaml` |
| `main` | production — `fly.vlab.digital`, `virtuallab-videos.netlify.app` | see Unresolved note above |
| `fix/replybot-restore-state-on-200` | — | live prod replybot (`v0.0.204`) |

**Pushing `staging` deploys the staging frontend immediately.** Backend services
do *not* deploy from the branch — they deploy from image tags in
`devops/values/staging.yaml` via Helm, as a separate step.

## Worked Example: replybot v0.0.203 vs v0.0.204

Both tags carry a commit titled *"feat(replybot): add synthetic restore_state
recovery event"*. They are **not** the same commit.

| | commit | lineage | `_isHandoffWait` guard | snapshot read from |
|---|---|---|---|---|
| `replybot-v0.0.203` | `5986b3e4` | on `main` (staging) | present (5 uses) | `nxt.payload.state` |
| `replybot-v0.0.204` | `c30f755a` | prod line, **not** on `main` | **absent** | `nxt.event.value.state` |

`c30f755a` was branched from `d0f2adc2` (2026-06-11) and the restore_state
change cherry-picked onto it. That base predates `96f27e3e`
("fix(replybot): ignore user input during handoff wait"), which is why the
`_isHandoffWait` guard is absent. **This is intentional** — that guard is
staging-only work that has not been promoted to production.

Note the two implementations also read the state snapshot from **different
event shapes** (`nxt.payload.state` vs `nxt.event.value.state`). They are not
interchangeable; check which shape the recovery tooling emits before moving
either one between lineages.

### Why v0.0.204 appears "behind" v0.0.203

It is not behind. It is a different line: production baseline plus the
restore_state recovery work, nothing else.

## The Live Production Branch

`fix/replybot-restore-state-on-200` (tip `c30f755a`, tagged
`replybot-v0.0.204`) is the **live production branch**.

- `devops/values/production.yaml` pins `versionReplybot: v0.0.204`.
- Commit `5ed96e7c` ("chore(prod): reconcile versionReplybot 203 -> 204 to
  match live vprod") aligned the repo with what is actually running.

**Do not merge this branch into `main`, and do not delete it.** It will always
report as "unmerged" and will conflict in
`replybot/lib/typewheels/machine.js`, `transition.js`, and
`transition.test.js`, because it re-applies an already-present change from an
older base. That divergence is deliberate and is the point of the branch.

## Guidance When Auditing

1. A branch reporting "not merged into main" is not automatically stale —
   check whether it is a production lineage branch first.
2. Do not compare tags across lineages by version number. Compare by ancestry
   (`git merge-base --is-ancestor <fix-commit> <tag>`) to determine whether a
   given fix is genuinely present.
3. `git diff main...<branch>` (three dots) shows what a branch added *since its
   merge base*, not what `main` lacks. On an old base this vastly overstates
   unique work. Use `git diff main <branch>` (two dots), or compare file trees
   directly, to answer "does main already have this?".

## Cross-Links

- `documentation/staging-tagging-and-deploy.md` — the `-wa` suffix scheme for
  WhatsApp platform work, and the staging deploy runbook.
- `documentation/staging.md` — staging environment setup, URLs, secrets.
- `replybot/README.md` — replybot architecture and state-machine behavior.

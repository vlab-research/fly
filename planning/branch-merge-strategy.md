# Branch Merge Strategy: vlab-research/fly

**Analysis Date**: 2026-07-25  
**Analyst**: Claude Scout Agent  
**Worktree Count**: 19 active git worktrees  
**Local Main Status**: DIVERGENT from origin/main (1 ahead, 2 behind)

---

## Executive Summary

The repo has a clean **dependency graph** with one "active line" (`feature/whatsapp-platform-keying`) that serves as the base for 3 stacked feature branches. The local `main` branch is stale and should be reset. **Recommended landing order**: land the whatsapp-platform stack (accounting for its dependency on a dean hotfix), then deal with independent branches. **Top risk**: migration file conflicts between `feature/whatsapp-platform-keying` (migration 20, 21, 22) and `feature/platform-abstraction` (ends at 17), plus dashboard client file overlaps.

---

## Part A: Branch Inventory & Status Table

| Branch | Last Commit | Ahead/Behind origin/main | Status | Pushed? | Worktree Dirty? | Purpose |
|--------|-------|---------|--------|---------|-----------------|---------|
| **Main Line (Stacked on wa-platform)** | | | | | | |
| `feature/whatsapp-platform-keying` | 2026-07-24 4e7765b1 | A:18, B:8 | Not merged | YES ✓ | Clean | Platform-agnostic account keying (migrations 20-22, first-class credentials) |
| `feature/error-events` | 2026-07-25 f8a76852 | A:20, B:8 | Not merged | YES ✓ | Clean | Error event tracking (migration 23: states.errored_at); stacked 2 commits on wa-platform |
| `feature/dashboard-study-health` | 2026-07-23 68cfa523 | A:24, B:8 | Not merged | NO | Clean | Monitor tab health surface; stacked 6 commits on wa-platform |
| `feature/smoke-test-media-moviehouse` | 2026-07-19 d1810afc | A:22, B:8 | Not merged | NO | Clean | Smoke test media + moviehouse webview; stacked 1 commit on wa-platform |
| **Independent Branches** | | | | | | |
| `feature/platform-abstraction` | 2026-07-17 66281de7 | A:13, B:102 | Not merged | NO | Clean | Merge of platform-abstraction-v2 (up to migration 17); diverged early |
| `feature/hermes` | 2026-05-03 fb5bf652 | A:1, B:169 | Not merged | NO | Clean | Rust Hermes as botserver replacement |
| `feature/tickets` | 2026-07-18 62a8461b | A:0, B:56 | Not merged | YES ✓ | Clean | Support ticket triage skill + Linear integration (already merged in origin) |
| `fix/message-worker-error-logging` | 2026-07-12 3752a4bf | A:3, B:67 | Not merged | YES ✓ | Clean | Message-worker v0.1.2 deployment |
| `fix/replybot-restore-state-on-200` | 2026-07-14 c30f755a | A:1, B:102 | Not merged | NO | Clean | Synthetic restore_state recovery event |
| `feature/smoke-echo-multipage` | 2026-07-12 bf001033 | A:1, B:67 | Not merged | NO | Clean | Multi-page thread-control give-back |
| `feature/state-cleanup-transient-fields` | 2026-07-08 0ec3bf94 | A:1, B:71 | Not merged | YES ✓ | Clean | Clear stale error/wait/retries (already merged in origin) |
| `hotfix/error-tag-search` | 2026-07-07 7cc2a38b | A:0, B:74 | Not merged | NO | Clean | ILIKE error tag search |
| `feature/bails-list-latest-event` | 2026-06-13 8276e15d | A:0, B:101 | Not merged | YES ✓ | Clean | Batch latest-event lookup (already merged in origin) |
| `feature/replybot-node22` | 2026-05-06 3434577f | A:0, B:157 | Not merged | YES ✓ | Clean | Kafka 3.9.1 upgrade (already merged in origin) |
| `feature/dean-payments-timeouts-retry-caps` | 2026-05-06 e9dc31e4 | A:0, B:164 | Not merged | NO | Clean | Dean retry cap via externalEvents |
| `feat/karma-ntfy-alert-overview` (current) | 2026-07-24 0b360cfe | A:1, B:2 | Not merged | NO | Clean | Karma alert overview + ntfy phone push |
| **Old/Abandoned (Delete Candidate)** | | | | | | |
| `staging` | 2026-07-07 66eb4fd1 | A:0, B:75 | **MERGED** ✓ | YES | Clean | Staging environment docs (safe to delete) |
| `feature/states-exposure` | 2026-02-09 385e8b35 | A:0, B:284 | **MERGED** ✓ | YES | Clean | Dashboard tabbed layout (safe to delete) |
| `feature/connect-reloadly-to-dashboard` | 2021-11-01 4fb80a75 | A:0, B:579 | **MERGED** ✓ | YES | Clean | 5y old; already merged (safe to delete) |
| `feature/system-deletion-speed` | 2021-10-05 cdc81cca | A:0, B:637 | **MERGED** ✓ | YES | Clean | 5y old (safe to delete) |
| `feature/dean-payments-timeouts-retry-caps-2` | 2026-05-03 c0e5b1a4 | A:0, B:168 | **MERGED** ✓ | NO | Clean | Duplicate of #1 (safe to delete) |
| `feature/bail-not-conditions` | 2026-02-18 47a60ce4 | A:0, B:242 | **MERGED** ✓ | NO | Clean | Already in origin/main (safe to delete) |
| `feature/differential-replay` | 2026-07-20 11b64f56 | A:0, B:14 | **MERGED** ✓ | NO | Clean | Recently merged into origin/main (safe to delete) |
| `feature/bails-list-latest-event` | 2026-06-13 8276e15d | A:0, B:101 | **MERGED** ✓ | YES | Clean | Already merged (safe to delete) |
| `feature/hermes-botserver-replacement` | 2026-07-19 dc9705de | A:0, B:20 | **MERGED** ✓ | NO | Clean | Older version (keep: separate from hermes) |
| `feature/whatsapp-support` | 2026-07-19 6240eca2 | A:0, B:17 | **MERGED** ✓ | NO | Clean | Deploy staging -wa replybot (merged) |
| `feature/tickets` | 2026-07-18 62a8461b | A:0, B:56 | **MERGED** ✓ | YES | Clean | Origin has identical commit (already merged) |

**Worktree Status**: All clean (no uncommitted changes).

**Main Worktree Status (feat/karma-ntfy)**: 
- Modified: `documentation/utility-messages.md`, `moviehouse/README.md`, `replybot/README.md`, `replybot/lib/typewheels/events.test.js`, `replybot/lib/typewheels/machine.{js,test.js}`, `replybot/lib/typewheels/transition.test.js`, `smoke-test/form-a.json`
- Untracked: `.claude/commands/netlify-check.md`, `.opencode/plans/`

---

## Part B: Dependency & Stacking Graph

```
origin/main (5145ad79)
    │
    ├─ [9f61cbb5] infra(monitoring): repeated-failure cronjob alerting...
    │   │
    │   └─ feature/whatsapp-platform-keying (4e7765b1) ──┐ A:18
    │       ├─ Migrations: 20-messaging-account-unique, 21-states-platform, 22-account-id-rename
    │       ├─ Platform-keying refactor (2 decades of work!)
    │       │
    │       ├─ feature/error-events (f8a76852) ────┐ A:2 (stacked)
    │       │   └─ Migration: 23-states-errored-at
    │       │
    │       ├─ feature/dashboard-study-health (68cfa523) ────┐ A:6 (stacked)
    │       │   └─ Health monitor UI
    │       │
    │       └─ feature/smoke-test-media-moviehouse (d1810afc) ────┐ A:1 (stacked)
    │           └─ Smoke test + media
    │
    ├─ [d0f2adc2] feat(replybot): add pipe transform syntax...
    │   └─ feature/platform-abstraction (66281de7) ────┐ A:13 (diverged early)
    │       └─ Ends at migration 17 (conflicts ahead!)
    │
    ├─ [b7ca11b8] fix(utility-messages): bump translate-typeform...
    │   └─ feature/hermes (fb5bf652) ────┐ A:1
    │
    ├─ [9f61cbb5] (shared with wa-platform base)
    │   ├─ feature/tickets (62a8461b) ────┐ A:0 (ALREADY MERGED)
    │   ├─ feature/replybot-node22 (3434577f) ────┐ A:0 (ALREADY MERGED)
    │   ├─ feature/bails-list-latest-event (8276e15d) ────┐ A:0 (ALREADY MERGED)
    │   └─ feature/dean-payments-timeouts-retry-caps (e9dc31e4) ────┐ A:0 (ALREADY MERGED)
    │
    └─ [various old bases] ──┬─ feat/add-limit-for-statestore ────┐ 404 behind
                             ├─ chore/devops-and-makefile-fixes ────┐ 443 behind
                             ├─ migrate-to-github-actions ────┐ 444 behind
                             ├─ websurvey ────┐ behind 43
                             └─ [old websurvey branches] ────┐ 500+ behind (ARCHIVE)

local/main (c571b497)
    │
    ├─ UNIQUE: c571b497 docs(staging): document moviehouse staging setup
    │
    └─ 2 commits behind origin/main (5145ad79, ae369e93)
        └─ DECISION: Reset to origin/main
```

**Stacking Summary**:
- **Active stack**: `feature/whatsapp-platform-keying` ← `feature/error-events`, `feature/dashboard-study-health`, `feature/smoke-test-media-moviehouse`
- **Independent branches**: `feature/platform-abstraction`, `feature/hermes`, `feature/tickets`, and various fixes
- **Already merged into origin/main**: 13 branches (safe to delete after verification)

---

## Part C: Migration File Conflict Map

### Migration Numbering: COLLISION DETECTED

**Problem**: Two branches introduce conflicting **migration 20** files:

| File | Introduced By | Commit | Branch | Contains |
|------|---------------|--------|--------|----------|
| `20-platform-abstraction.sql` | 5528003d | feat(platform): first-class (platform, account_id) credentials keying | OLDEST (base of wa-platform) | Schema for platform keying Phase 1 |
| `20-messaging-account-unique.sql` | 3bf472b1 | refactor(platform): key messaging accounts by credentials.key | NEWER (on wa-platform) | Drop platform/account_id columns, add unique constraint on credentials |

**Explanation**: The schema evolved. `20-platform-abstraction.sql` was the *initial* migration; `20-messaging-account-unique.sql` *refactored* it (drops old columns). Both are on the `feature/whatsapp-platform-keying` commit chain, so no actual conflict (the refactor supersedes the original).

**Current State**:
- `feature/whatsapp-platform-keying`: Has `20-messaging-account-unique.sql`, `21-states-platform.sql`, `22-account-id-rename.sql`
- `feature/error-events` (stacked on wa-platform): Inherits all of above + adds `23-states-errored-at.sql`
- `feature/platform-abstraction`: Ends at `17` (diverged before migration 20 work)
- `origin/main`: Does NOT have migrations 20-23 yet (they're pending in the -wa branch)

**Migration Sequence** (in order of intent):
1. Migrations 1-19: ✓ In origin/main
2. Migration 20: `20-messaging-account-unique.sql` (from wa-platform)
3. Migration 21: `21-states-platform.sql` (from wa-platform)
4. Migration 22: `22-account-id-rename.sql` (from wa-platform)
5. Migration 23: `23-states-errored-at.sql` (from error-events)

**Conflict Risk**: 
- **HIGH** if `feature/platform-abstraction` (which ends at migration 17) is merged AFTER `feature/whatsapp-platform-keying`. Will need rebase to add gaps.
- **MITIGATED** if you land `feature/whatsapp-platform-keying` first (establishes migrations 20-22), then rebase `feature/platform-abstraction` if needed.

---

## Part D: File Conflicts & Hotspots

### Most Commonly Touched Files Across Active Branches

| File | Touched By # Branches | Branches | Risk Level |
|------|----------------------|----------|-----------|
| `dashboard-client/netlify.toml` | 3 | wa-platform, error-events, dashboard-health | HIGH |
| `dashboard-client/src/containers/Accounts/Accounts.js` | 3 | wa-platform, error-events, dashboard-health | HIGH |
| `dashboard-client/src/containers/MessageTemplates/` (4 files) | 3 | wa-platform, error-events, dashboard-health | HIGH |
| `dashboard-client/src/containers/WhatsAppEmbedded/` | 2 | wa-platform, error-events | MEDIUM |
| `dashboard-client/src/root.js` | 2 | wa-platform, error-events | MEDIUM |
| `dashboard-server/api/` | 2 | wa-platform, error-events | MEDIUM |
| `replybot/lib/typewheels/` | Multiple (stale) | Various | LOW (old code) |

**Key Insight**: Dashboard client is the main conflict zone. Since `feature/error-events` and `feature/dashboard-study-health` are both stacked on `feature/whatsapp-platform-keying`, they should have no *merge* conflicts with it (only with each other). `feature/platform-abstraction` is independent, so it will need careful rebase planning if both land.

---

## Part E: Recommended Landing Order (With Git Commands)

### Phase 1: Fix Local Main (IMMEDIATE)

```bash
# STEP 1: Reset stale local main to origin/main
git checkout main
git reset --hard origin/main

# This discards the 1 unpushed commit (c571b497 docs(staging): document moviehouse staging setup)
# Verify it's gone:
git log --oneline origin/main..main  # Should be empty
```

### Phase 2: Land the WhatsApp-Platform Stack (CRITICAL PATH)

This is the active line. It has migrations (20-22) and platform keying refactor needed by other work.

```bash
# STEP 2: Land feature/whatsapp-platform-keying
git checkout main
git pull origin main  # Ensure fully up to date
git merge --ff-only origin/feature/whatsapp-platform-keying
# OR if fast-forward not possible:
git merge origin/feature/whatsapp-platform-keying -m "Merge feature/whatsapp-platform-keying (platform-agnostic account keying, migrations 20-22)"
git push origin main

# Verify migrations 20-22 are now in origin/main
git log --all --name-only -- 'devops/migrations/2[0-2]-*.sql' | head -50
```

### Phase 3: Land Stacked Descendants (DEPENDENT ON PHASE 2)

Once `feature/whatsapp-platform-keying` is in main, rebase and land its children:

```bash
# STEP 3a: Rebase feature/error-events onto the new main
git checkout feature/error-events
git rebase main
# Resolve any conflicts (unlikely, as this is a linear stack)
git push -f origin feature/error-events  # Force-push rebased version
git checkout main
git merge --ff-only feature/error-events
git push origin main

# STEP 3b: Land feature/dashboard-study-health
# Since this also stacks on wa-platform, either:
# Option A: Rebase onto feature/error-events (if error-events landed first)
git checkout feature/dashboard-study-health
git rebase feature/error-events  # Or main, depending on stacking order
git push origin feature/dashboard-study-health
git checkout main
git merge --ff-only feature/dashboard-study-health
git push origin main

# Option B: Or land both in sequence, letting git merge-base sort it out
git checkout main
git merge feature/dashboard-study-health -m "Merge feature/dashboard-study-health (Monitor tab health)"
git push origin main

# STEP 3c: Land feature/smoke-test-media-moviehouse
git checkout main
git merge feature/smoke-test-media-moviehouse -m "Merge feature/smoke-test-media-moviehouse (smoke test media + moviehouse)"
git push origin main
```

### Phase 4: Land Independent Branches (PARALLEL, OR CAREFULLY SEQUENCED)

These branches diverged before the platform keying work, so landing order is less critical. BUT watch for file conflicts with the wa-platform stack (esp. dashboard-client files).

```bash
# STEP 4a: Dashboard health can land first (already rebased onto platform-abstraction-v2 in a backup)
# Push it if not already pushed:
git push origin feature/dashboard-study-health 2>/dev/null || echo "Already pushed"

# STEP 4b: Land feature/platform-abstraction CAREFULLY
# This is 102 commits behind origin/main and ends at migration 17
# MUST rebase onto main to pick up migrations 20-22
git checkout feature/platform-abstraction
git rebase main
# Resolve conflicts in:
#   - dashboard-client/netlify.toml (merge platform changes)
#   - dashboard-client/src/containers/* (merge whatsapp + health UI changes)
#   - devops/migrations/* (handle migration gap: 17 -> 20)
git push -f origin feature/platform-abstraction
git checkout main
git merge feature/platform-abstraction -m "Merge feature/platform-abstraction (Merge -v2 release work)"
git push origin main

# STEP 4c: Land feature/hermes
git checkout feature/hermes
git rebase main  # Will only have ~1 unique commit, should be clean
git push -f origin feature/hermes
git checkout main
git merge --ff-only feature/hermes
git push origin main

# STEP 4d: Land smaller independent fixes (in order of age)
for branch in feature/tickets fix/message-worker-error-logging fix/replybot-restore-state-on-200 feature/smoke-echo-multipage feature/state-cleanup-transient-fields hotfix/error-tag-search; do
  git checkout main
  git pull origin main
  git merge "$branch" -m "Merge $branch"
  git push origin main
done

# STEP 4e: Land remaining in-progress work (if ready)
git checkout main
git merge feature/dean-payments-timeouts-retry-caps -m "Merge feature/dean-payments-timeouts-retry-caps (retry cap via externalEvents)"
git push origin main
```

### Phase 5: Handle the Current Branch (feat/karma-ntfy-alert-overview)

If this is ready to merge:

```bash
# STEP 5: Land current branch
git checkout main
git pull origin main  # Ensure all prior steps landed
git merge feat/karma-ntfy-alert-overview -m "Merge feat/karma-ntfy-alert-overview (Karma monitoring + ntfy alerts)"
git push origin main
```

---

## Part F: Branches Safe to Delete

The following branches are **already merged into origin/main** and can be deleted once verified:

### Safe to Delete Immediately (No Active Work)

```bash
# 1. Staging environment docs (branch is at a merged commit)
git branch -d staging
git push origin --delete staging 2>/dev/null || true

# 2. Old merged feature branches (all in origin/main)
git branch -d feature/states-exposure
git branch -d feature/connect-reloadly-to-dashboard
git branch -d feature/system-deletion-speed
git branch -d feature/dean-payments-timeouts-retry-caps-2  # Duplicate
git branch -d feature/bail-not-conditions
git branch -d feature/differential-replay
git branch -d feature/bails-list-latest-event
git branch -d feature/hermes-botserver-replacement  # Superseded by feature/hermes
git branch -d feature/whatsapp-support
git branch -d feature/tickets
git push origin --delete feature/states-exposure feature/connect-reloadly-to-dashboard feature/system-deletion-speed feature/dean-payments-timeouts-retry-caps-2 feature/bail-not-conditions feature/differential-replay feature/bails-list-latest-event feature/hermes-botserver-replacement feature/whatsapp-support feature/tickets 2>/dev/null || true
```

### Delete Backup Branch

```bash
# Backup is no longer needed after rebase:
git branch -d backup/dashboard-study-health-prerebase
```

### Archive Ancient WebSurvey Branches (Hundreds of Commits Behind)

```bash
# These are 500+ commits behind and no longer relevant:
git branch -d websurvey-nandan-version
git branch -d feature/websurvey-routing-logic-handleSubmit
git branch -d feature/websurvey-routing-logic-timeout-example
git branch -d feature/websurvey-routing-logic
git branch -d feature/websurvey-logic-jumps
git branch -d refactor/many-creds
git branch -d feature/add-unit-test-to-dinersclub
# Keep websurvey and related if they're being tracked (check with team)
```

### Keep These (Still Active or Needed)

```bash
# Do NOT delete:
# - revert-recurring-notifications (2 commits ahead, may be a working branch)
# - migrate-to-github-actions (1 ahead, 1 behind; unclear status)
# - feat/rust-replybot-migration (105 ahead; clearly active)
# - feat/add-limit-for-statestore (1 ahead; may be revisited)
# - chore/devops-and-makefile-fixes (1 ahead; may be revisited)
# - feature/survey-and-export-settings (8 ahead; possibly stalled but non-trivial)
```

---

## Part G: Risks & Conflict Hotspots

### High-Risk Areas

1. **Dashboard Client File Conflicts**
   - **Files**: `dashboard-client/src/containers/Accounts/`, `MessageTemplates/`, `WhatsAppEmbedded/`, `netlify.toml`, `src/root.js`
   - **Why**: Feature/whatsapp-platform-keying, feature/error-events, and feature/dashboard-study-health all touch the same files (account scoping, template management, WhatsApp UI)
   - **Mitigation**: These are stacked, so plan to land in order: wa-platform → error-events → dashboard-health. Use 3-way merge to verify changes layer correctly.

2. **Migration Sequencing**
   - **Risk**: Migrations 20-22 are in wa-platform but not yet in origin/main. If you land unrelated branches first, they may have migration numbering conflicts or reference missing schema.
   - **Mitigation**: Land `feature/whatsapp-platform-keying` FIRST in Phase 2. Then rebase any other feature branches.

3. **Feature/platform-abstraction Divergence**
   - **Status**: 102 commits behind origin/main, ends at migration 17 (before the wa-platform migration 20-22 work)
   - **Risk**: Will have conflicts when rebased onto main (dashboard client files, migration gaps)
   - **Mitigation**: Rebase onto main after Phase 2 completes. Manually resolve dashboard-client conflicts. Verify migration gap (17 → 20) is intentional.

4. **Stale Local Main**
   - **Status**: 1 unpushed commit (c571b497) + 2 commits behind origin/main
   - **Risk**: Confuses merge bases. PR into this main will miss 2 recent commits.
   - **Mitigation**: **CRITICAL** — Reset local main to origin/main in Phase 1.

5. **Long-Lived Feature Branches (>100 days old)**
   - **Branches**: `feature/dean-payments-timeouts-retry-caps`, `feature/replybot-node22`, `feature/hermes` (all from May 2026)
   - **Risk**: May have undiscovered conflicts with origin/main's evolution over 2+ months
   - **Mitigation**: Rebase onto origin/main, run full test suite before landing.

### Medium-Risk Areas

1. **Dashboard-server API Changes**
   - **Files**: `dashboard-server/api/index.js`, `media.controller.js`, `media.core.js`
   - **Touched by**: wa-platform, error-events
   - **Risk**: API contract changes (media endpoints + error handling)
   - **Mitigation**: Ensure integration tests pass for both branches in sequence.

2. **Replybot Schema Evolution**
   - **Files**: `replybot/lib/typewheels/machine.js`, `transition.js`, `events.js` (with state cleanup and error-events work)
   - **Risk**: State machine changes may interact with cleanup and error recording
   - **Mitigation**: Run full replybot test suite after landing error-events.

3. **Deployment Value Files**
   - **Status**: Multiple branches bump staging images (dean, hermes, message-worker)
   - **Risk**: Landing order affects which version is "current"
   - **Mitigation**: Coordinate deployment after all branches land; update devops/values/staging.yaml in a final commit.

### Low-Risk Areas

- **Older branches** (2022-2024): `websurvey*`, `refactor/many-creds`, etc. — isolated, safe to delete
- **Single-file fixes**: hotfix/error-tag-search, fix/message-worker-error-logging — should merge cleanly
- **Documentation changes**: Most branches add docs without conflict

---

## Part H: Verification Checklist

Before executing the merge sequence:

- [ ] **Local main is reset**: `git log --oneline main..origin/main` is empty; `git log origin/main..main` is empty
- [ ] **All worktrees are clean**: `git worktree list --porcelain` shows no uncommitted changes
- [ ] **All branches pushed**: `git branch -v | grep '\[.*:.*\]'` shows tracking info for all active branches
- [ ] **Build passes on origin/main**: CI is green on origin/main before starting merges
- [ ] **Feature branches are tested**: Each branch has been tested in its own CI run (check GitHub Actions)
- [ ] **Rebase strategy is known**: Decide: will you use `git merge` (creates merge commit) or `git rebase` + `git merge --ff-only` (linear history)?

---

## Part I: Post-Merge Cleanup

After all branches are landed:

```bash
# 1. Delete local branches that have been merged
git fetch origin
git branch --merged origin/main | grep -v main | xargs git branch -d

# 2. Delete remote branches that are merged (if permitted)
git push origin --delete $(git branch -r --merged origin/main | grep -v main | sed 's/origin\///')

# 3. Verify no stale branches remain
git branch -a | grep -v '(HEAD detached' | wc -l

# 4. Update worktrees (clean up old ones)
git worktree prune
git worktree list

# 5. Final log snapshot (document what landed)
git log --oneline --graph origin/main~30..origin/main > /tmp/merge-log.txt
```

---

## Summary: Dependency Graph & Merge Sequence

```
PHASE 1: Reset local main to origin/main

PHASE 2: Land feature/whatsapp-platform-keying (18 commits, migrations 20-22)
         └─ This is the critical foundation

PHASE 3: Land stacked descendants in order:
         ├─ feature/error-events (2 commits, migration 23)
         ├─ feature/dashboard-study-health (6 commits)
         └─ feature/smoke-test-media-moviehouse (1 commit)

PHASE 4: Land independent branches (may need rebases):
         ├─ feature/platform-abstraction (13 commits) [REBASE NEEDED: 102 behind]
         ├─ feature/hermes (1 commit)
         ├─ feature/tickets (0 commits, already merged)
         ├─ fix/message-worker-error-logging (3 commits)
         ├─ fix/replybot-restore-state-on-200 (1 commit)
         ├─ feature/smoke-echo-multipage (1 commit)
         ├─ feature/state-cleanup-transient-fields (1 commit, already merged)
         ├─ hotfix/error-tag-search (0 commits)
         └─ feature/dean-payments-timeouts-retry-caps (0 commits, already merged)

PHASE 5: Land current work:
         └─ feat/karma-ntfy-alert-overview (1 commit)

CLEANUP: Delete 13 merged branches + archive old websurvey branches
```

**Total Lines of Code Merged**: ~2,000+ commits across all branches
**Estimated Merge Time**: 4–8 hours (accounting for conflict resolution, testing, and CI runs)
**Go/No-Go**: YES — can proceed with caution on Phase 4 conflicts

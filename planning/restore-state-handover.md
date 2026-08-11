# Handover — `restore_state` recovery + prod incident (2026-07-15)

**For the next agent.** Read this fully before acting. Companion doc with deep technical detail:
`planning/staging-production-traffic-leak.md` (the incident + remediation plan; §6.5-RESULTS and §6.5-RESULTS-B have the validated findings).

---

## 0. TL;DR

- A `restore_state` recovery event was built to un-block ~127 falsely-`USER_BLOCKED` prod participants (from the staging→prod Kafka leak). **The code is correct and additive.**
- **An incident was caused by the DEPLOY, not the code:** prod replybot was on **v0.0.200**, but the image was built from `main` HEAD, which was **v0.0.203 = 200 + 201 + 202 + restore_state**. Shipping that to prod dragged in the unvalidated 201/202-era changes and **broke prod**. User rolled prod back to **v0.0.200** (helm rev 610).
- **Immediate task (user's explicit instruction):** rebuild the image as **v0.0.200 code + ONLY the `restore_state` fix**, run the full test suite **including integration tests**, report, then push a tag to build the container. **Do NOT deploy** — the user will. **Do NOT touch any prod state.**

---

## 1. IMMEDIATE NEXT TASK (do this first)

Build a clean replybot image = **v0.0.200 + restore_state only**.

### Critical git correction
The user said "branch from current main, which is 200." **`main` is NOT 200** — `main` HEAD is `4f86f45` and already contains `restore_state` (`5986b3e`) *and* the 201/202 changes. Version→commit map (all in main's linear history):

| tag | commit | subject |
|---|---|---|
| `replybot-v0.0.200` | **`d0f2adc`** | feat(replybot): add pipe transform syntax for interpolation |
| `replybot-v0.0.201` | `138d1ea` | docs: add message-worker deployment guide |
| `replybot-v0.0.202` | `96f27e3` | fix(replybot): ignore user input during handoff wait |
| `replybot-v0.0.203` | `5986b3e` | **feat(replybot): add synthetic restore_state recovery event** (the fix) |

So the **true v0.0.200 base is `d0f2adc`**, and the fix to cherry-pick is **`5986b3e`**.

### Steps
1. `git branch fix/replybot-restore-state-on-200 d0f2adc` (branch from the *real* 200 base, not main HEAD).
2. `git cherry-pick 5986b3e` (the restore_state commit).
   - This touches `replybot/lib/typewheels/{machine.js,transition.js,machine.test.js,transition.test.js}`.
   - **Possible conflict:** `5986b3e` was authored on top of `0f40f83` (post-202), so it was written against a machine.js that already had `96f27e3` "ignore user input during handoff wait". Cherry-picking onto `d0f2adc` (pre-202) may conflict in `machine.js`/`transition.js`. The restore_state additions are in `categorizeEvent` (one `_synth` line), a new `exec` case, a new `apply` case, and the `RESET`→`RESET||RESTORE_STATE` line in `transition.js:run()`. Resolve so ONLY those additive pieces land; keep the 200-base handoff logic as-is.
3. `cd replybot && nvm use && npm ci` (or `npm install`), then **run the full suite**:
   - Unit: `npm test` (= `nyc npm run _test` = `mocha --colors lib/**/*.test.js`). The 6 new RESTORE_STATE tests must pass (see §5).
   - **Integration:** the user explicitly wants these. See `.github/workflows/replybot-test.yml` and `.github/workflows/testcontainers-integration.yml` for how CI runs them; reproduce locally (likely testcontainers-based — needs Docker). Confirm the exact command from those workflows.
4. **Report results to the user and wait.** (User said "let me know when you're done with that.")
5. On their go: tag a **new version** (203 is burned on the bad image — use **`replybot-v0.0.204`**) on the branch tip and `git push` the tag → `release.yml` builds `ghcr.io/vlab-research/replybot:v0.0.204`. Do NOT bump `production.yaml`/helm; the user deploys.

### What actually broke prod (for context)
`git log replybot-v0.0.200..HEAD -- replybot/` shows the 200→203 delta included, besides the additive `restore_state`: `96f27e3` (handoff-wait behavior), `fa1d78e` (**pg override to ^8.11.3 for CockroachDB v24** — a dependency change), `a325533` (message-worker "commit WIP fixes"), `248c89c` (message-worker native passthrough). The restore_state commit is provably additive, so the culprit is one of the 201/202-era changes — most suspicious: `fa1d78e` (pg dep) or `a325533` (WIP). Not yet root-caused; not required for the immediate task, but note it if the user wants the real cause.

---

## 2. The `restore_state` change (what the fix does)

Recovery-only synthetic event that overwrites a user's state from a self-contained snapshot and advances the message pointer to "now", so a Redis-miss reload re-hydrates the snapshot and never re-folds the `block_user` before it (durable un-block, full `qa`/state preserved). Precedent: `machine_report` events already carry a full state in `event.value`.

Files (commit `5986b3e`):
- `machine.js` `categorizeEvent`: `if (_synth('restore_state', nxt)) return 'RESTORE_STATE'`.
- `machine.js` `exec`: new `RESTORE_STATE` case → `{action:'RESTORE_STATE', stateUpdate:{...nxt.event.value.state, pointer: nxt.timestamp}}` (unconditional — must fire from USER_BLOCKED live *and* from START on reload).
- `machine.js` `apply`: new `RESTORE_STATE` case → `{..._initialState(), ...output.stateUpdate}`.
- `transition.js` `run()`: `if (output.action === 'RESET' || output.action === 'RESTORE_STATE')` short-circuit → publishes `newState` to state topic + Redis with **no getPageToken/getForm/getUser IO and no outbound FB message / commands**. This is what guarantees "no message on restore".

Event body posted to botserver `/synthetic` (botserver adds `source:'synthetic'` + `timestamp:Date.now()`):
```json
{"user":"<uid>","page":"<pid>","event":{"type":"restore_state","value":{"state": <P> }}}
```

---

## 3. Current state of the world (verify before acting — data may have moved)

- **Prod replybot:** rolled back to **v0.0.200** (helm **rev 610**, ReplicaSet `gbv-replybot-75979c7d7d`, 8/8 healthy). The bad image was `v0.0.203` (helm rev 609).
- **`main`:** at `4f86f45`, contains `5986b3e` (restore_state) + `4f86f45` (prod values bump to 203). `production.yaml` `versionReplybot` was reverted to `v0.0.200` (by user/linter) — leave it.
- **The 125 (now ~125–126) target users:** still `USER_BLOCKED`, **untouched**. Batch was never emitted (only read-only prep done).
- **One user WAS restored and left as-is (user's decision):** `8915379505159684` / page `101435865704727`. Its `states` row + Redis show `WAIT_EXTERNAL_EVENT`. **Latent issue under v0.0.200:** v200 has no RESTORE_STATE handler, so on a Redis-miss its pointer-based reload folds `[restore_state(noop), machine_report(noop)]` → empty `START`. User said **do NOT touch it**. (A clean v0.0.204 deploy would fix its reload behavior.)
- **`gbv-dean-spammers` cron: SUSPENDED** in vprod (stops further false blocks). Un-suspend only after states are cleaned: `kubectl --context gke_toixotoixo_europe-west1-b_toixo patch cronjob gbv-dean-spammers -n vprod -p '{"spec":{"suspend":false}}'`.
- **Env/context:** GKE `gke_toixotoixo_europe-west1-b_toixo`, ns `vprod`/`vstag`, CockroachDB `chatroach` (query via `kubectl exec -i -n vprod gbv-cockroachdb-0 -- cockroach sql --insecure --database=chatroach --format=records < file.sql`; wrap in retry loops — exec is flaky). **zsh `noclobber`** blocks `>` overwrites — use `>|`.

---

## 4. Validated findings (from the read-only work — reuse, don't redo)

1. **Reconstruction is faithful.** Folding a user's full `messages` log (byte-exact via base64: `translate(encode(convert_to(content,'UTF8'),'base64'),e'\n','')`) through the real `machine.js getState` reproduces the live DB state exactly.
2. **Survey answers are safe** in the `responses` table regardless; `qa` only ever holds the *current form* (reset on every `SWITCH_FORM`), so "lost qa" was never the real problem.
3. **Best P source = the last pre-leak `machine_report.newState`** (`timestamp < 2026-07-10T19:54:00Z`); fallback = pre-leak-cutoff genesis fold. Spot-check of 10/127 users: **all fold to `WAIT_EXTERNAL_EVENT`, `wait: 1 month`** (a completed-baseline "Girl Effect" cohort on page `101435865704727` awaiting the endline). Homogeneous; none mid-survey; none spammers.
4. **Some stored `content` is invalid JSON** (`\U…` escapes). Prod `parseEvent` catches the error and returns the raw string → categorized `UNKNOWN` → noop. Any recovery script MUST tolerate this (lenient parse / skip).
5. **Single-user restore was executed and fully verified** (before rollback): un-blocked → `WAIT_EXTERNAL_EVENT` qa=4, pointer advanced, **no FB message** (report had no `commands`), and a pointer-based reload folded to `WAIT_EXTERNAL_EVENT` (block did not re-apply). The mechanism works.
6. **BLOCKER for the eventual batch (do not forget):** restoring to the true pre-leak `WAIT_EXTERNAL_EVENT` does **not** get users re-driven, because `DEAN_TIMEOUT_MAX_PAST=72h` and this cohort's timeouts are ~Jul 11 (>100h past → outside dean's window). Options (a research/ops decision, see §6.6-REVISED-B in the incident doc): A) re-arm `waitStart` in the snapshot so `timeout_date` lands in the last 72h; B) manually fire the timeout event per user; C) temporarily raise `DEAN_TIMEOUT_MAX_PAST` (**user chose C**) — blast radius measured **small**: a ~5-day window newly wakes only ~5 unrelated in-window users (avoid ≥30-day: wakes 13 ghosts >30d past). D) un-block only. **The endline delivery is a separate step AFTER a correct replybot is deployed.**

---

## 5. Tests added by the fix (must stay green)

In `machine.test.js` — `describe('RESTORE_STATE (recovery event)')`: restore from USER_BLOCKED sets P + advances pointer; restore from START (durability); clean-initial-state (no stray fields); no FB message via `getMessage`; exec output shape. In `transition.test.js` — `run()` short-circuit: publishes newState, no commands/responses, `actionsResponses` not called. Full suite was **179 passing** on the post-202 base; re-verify on the 200 base after cherry-pick.

---

## 6. Remaining work (after the clean image is built & user deploys)

1. Deploy v0.0.204 to prod (user-driven; verify diff is only the replybot image, like before).
2. Decide/execute the endline-delivery approach for the 125–126 (§4.6 / incident-doc §6.6). User leaned to **C (raise dean window)**; sequence = restore all to WAIT → widen `DEAN_TIMEOUT_MAX_PAST` just enough (~5d) → let dean drain (fires all in-window; blacklist path has no `LIMIT 1`) → **revert the window**.
3. Batch the restores: re-derive the target list at run time (`USER_BLOCKED`, `updated >= '2026-07-13 21:10'`, the 6 pages — currently all on `101435865704727`), reconstruct P per user (§4.3), emit via botserver `/synthetic` (port-forward `svc/gbv-botserver 8899:80`). Reconstruction logic was in a scratchpad script `_batch_build.js` (session-ephemeral — recreate from §4; it wrote `batch_events.jsonl`).
4. Re-enable `gbv-dean-spammers` only after states are clean.
5. Prevention (incident-doc §8): per-env consumer-group names; CI guard that values file matches target namespace; botserver `X-Hub-Signature-256` + page allowlist.

## 7. Notes / gotchas
- **Prod writes are gated** by the auto-mode permission classifier and need explicit user approval each time (port-forward, synthetic POST, cockroach exec have all prompted). Plan for it.
- **6 affected pages** literal: `('101435865704727','758018254333043','1855355231229529','111108121363615','110749071412124','107718334922830')` — but the 127 surge is entirely on `101435865704727`.
- Scratchpad artifacts (this session, ephemeral): exported logs, `targets.csv`, `event.json`, `batch_events.jsonl` under the session scratchpad dir — a new session won't have them; re-derive.
- **The deploy lesson:** always diff prod's *actually-running* commit vs the image you're about to build. "My change is additive" ≠ "the deploy delta is additive" when prod lags `main`.

# Rebase Plan: feature/platform-abstraction onto main

## What Changed on Main Since Branch Point

6 commits since `f95c48e`:

| Commit | Description | Impact |
|--------|-------------|--------|
| `d0f2adc` | Pipe transform syntax for interpolation (e164) | Medium — form.js `getDynamicValue` changed |
| `c2e2eed` | First-class handoff field type with `action: HANDOFF` | **HIGH** — fundamental handoff redesign |
| `2ac7672` | smoke-echo harness | Low — new directory, no conflicts |
| `65c5184` | Accept handovers when `new_owner_app_id` is a number | Medium — HANDOVER_EVENT security check fix |
| `ab750bf` | Keyset pagination in state debugger | Low — different file |
| `4fcd90e` | Staging/production parity | Low — devops only |

## Key Feature 1: Pipe Transform Syntax (e164)

**What it does:** `{{hidden:phone|e164}}` — pipe-separated transforms applied during interpolation.

**Changes in `form.js`:**
- `getDynamicValue()` now splits on `|`, applies transforms
- New `transforms` object with `e164` → calls `normalizePhone(v, '', false)`
- `normalizePhone` imported from `@vlab-research/translate-typeform`

**Impact on our branch:**
- Our `form.js` already ported `addCustomType` locally and removed the translate-typeform import
- We need to **also port `normalizePhone`** locally (like we did for `parseNumber`, `normalizeUnicodeNumerals`)
- We need to add the `transforms` object and pipe logic to our `getDynamicValue()`
- `normalizePhone` uses the `phone` package — already in replybot's dependencies (it was a transitive dep, now needs to be direct)

## Key Feature 2: First-Class Handoff (HIGH IMPACT)

**What changed:** Handoff is no longer extracted from message metadata at send time. Instead:
1. `addCustomType` in translate-typeform now parses `type: handoff` YAML and puts it in `md.handoff`
2. The old replybot `addCustomType` wrapper (which generated wait conditions for handoff) is **removed** — `addCustomType` now just returns `baseAddCustomType(field)` since the base handles it
3. New `action: 'HANDOFF'` in `exec()` — fired when **echo** of handoff message arrives, not on send
4. New `case 'HANDOFF'` in `apply()` — transitions to `WAIT_EXTERNAL_EVENT` with synthesized `wait: { type: 'handover' }`
5. New `case 'HANDOFF'` in `act()` — returns `{ messages: [], handoff: _wrapSideEffect(ctx, output.handoff) }`
6. `getHandoffFromMessage()` is **deleted** — handoff no longer comes from message metadata
7. Handoff translator: `translateHandoff = translateShortText` in translate-typeform — renders as text with handoff metadata

**Why the redesign:** If `passThreadControl` fires on send (before echo), Facebook routes the echo to the external app, not back to replybot. The wait never arms, and the survey gets stuck. The echo must come first.

**Impact on our branch:**

### 1. `generic-translator.js` — Add `handoff` type
Our translator doesn't have `handoff`. Main's translate-typeform maps it to `translateShortText` (= text type, preserves md including handoff metadata). We need to add it.

### 2. `machine.js` — Major changes needed
Our current code still uses the **old** handoff model:
- `act()` RESPOND case: `getHandoffFromMessage()` extracts handoff from message metadata
- No `action: 'HANDOFF'` in `exec()`
- No `case 'HANDOFF'` in `apply()` or `act()`

We need to add:
- `action: 'HANDOFF'` in `exec()` ECHO handler — when `md.type === 'handoff'`, return HANDOFF action with synthesized wait
- `case 'HANDOFF'` in `apply()` — transition to WAIT_EXTERNAL_EVENT with handover wait
- `case 'HANDOFF'` in `act()` — return `{ messages: [], handoff: _wrapSideEffect(ctx, output.handoff) }`
- Remove `getHandoffFromMessage()` — handoff no longer extracted from message metadata
- Remove handoff from RESPOND case in `act()`

### 3. `machine.js` — HANDOVER_EVENT `new_owner_app_id` String() fix
Our HANDOVER_EVENT handler still uses strict `!==` comparison:
```javascript
if (new_owner_app_id && new_owner_app_id !== process.env.FACEBOOK_APP_ID)
```
Needs to be:
```javascript
const ourAppId = process.env.FACEBOOK_APP_ID
if (new_owner_app_id && ourAppId && String(new_owner_app_id) !== String(ourAppId))
```

### 4. `event-normalizer.js` — `new_owner_app_id` String coercion
Our normalizer passes `new_owner_app_id` through raw. Main's `waiting.js` now does `String(event.pass_thread_control.new_owner_app_id)`. Since our normalizer is the canonical source, we should coerce to string **in the normalizer** so downstream consumers don't need to worry about type.

### 5. `form.js` — `addCustomType` simplification
Main's `addCustomType` now just returns `baseAddCustomType(field)` — the handoff wait generation is removed because the runtime handles it. Our ported `addCustomType` still has the old handoff extension code. We need to remove it — the base YAML parsing already puts `type: 'handoff'` and `handoff: { ... }` into `md`, and the runtime's ECHO handler creates the HANDOFF action.

### 6. `generic-validator.js` — No handoff validator needed
Main's translate-typeform doesn't have a `handoff` validator. Since handoff is a statement-like field (user never "answers" it), no validation is needed.

## Rebase Strategy

### Option A: Rebase then fix (recommended)
1. `git rebase main` in the worktree — will have conflicts in heavily-modified files
2. Resolve conflicts — our changes dominate since we rewrote so much
3. Apply the handoff and pipe-transform features into our new architecture
4. Run tests, fix any issues

### Option B: Manual merge
1. Cherry-pick each commit and adapt to our new architecture
2. More controlled but slower

**Recommendation:** Option A. The conflicts will be in files we completely rewrote (machine.js, form.js, transition.js), so our versions will dominate. Then we manually integrate the new features.

## Post-Rebase Integration Checklist

1. [ ] `generic-translator.js` — Add `handoff` → text type mapping
2. [ ] `generic-validator.js` — Verify no handoff validator needed
3. [ ] `machine.js` — Add `action: 'HANDOFF'` in exec ECHO handler
4. [ ] `machine.js` — Add `case 'HANDOFF'` in `apply()`
5. [ ] `machine.js` — Add `case 'HANDOFF'` in `act()`
6. [ ] `machine.js` — Remove `getHandoffFromMessage()`, remove handoff from RESPOND
7. [ ] `machine.js` — Fix HANDOVER_EVENT `String()` comparison
8. [ ] `event-normalizer.js` — Coerce `new_owner_app_id` to String in handover payload
9. [ ] `form.js` — Remove old handoff extension from `addCustomType`
10. [ ] `form.js` — Add pipe transform syntax (`transforms`, `e164`) to `getDynamicValue`
11. [ ] `form.js` — Port `normalizePhone` locally
12. [ ] `package.json` — Ensure `phone` package is a direct dependency
13. [ ] `waiting.js` — Remove raw `pass_thread_control` fallback (event-normalizer handles it)
14. [ ] Tests — Update handoff tests for new HANDOFF action flow
15. [ ] Tests — Add pipe transform tests
16. [ ] Tests — Add `new_owner_app_id` number coercion test
17. [ ] Full test suite passes
18. [ ] Lint clean

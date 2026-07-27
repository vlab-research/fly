# message-worker: stop tagging pre-flight failures as `FB`

**Target branch: `staging`.** This is a Go change on the message send path — it does not
belong on a monitoring branch and must soak in `vstag` before any production promotion.

**Size:** ~15 lines in one file, plus tests. **Risk:** medium — it changes which state a
failed send lands in, on the hot path.

---

## The bug

`message-worker/worker.go:327-336` tags **every** `*PlatformError` as `"FB"`:

```go
if IsPlatformError(err) {
    tag = "FB"
    ...
}
```

But `PlatformError` is returned in two very different situations:

1. **The provider answered and rejected us** — a real Meta HTTP response, `StatusCode > 0`.
2. **We never reached the provider** — `StatusCode: 0`, returned *before* any HTTP request
   exists. Six call sites: `messenger_client.go:67, 111, 208, 239` and
   `whatsapp_client.go:54, 89`.

Only case 1 is a Facebook error. Case 2 is ours.

**Why it matters:** `replybot/lib/typewheels/machine.js:288` routes `tag === 'FB'` to
**`BLOCKED`** and everything else with an error to `ERROR`. `BLOCKED` is terminal, and dean
only escapes it via `fb_error_code = ANY($1)` (`dean/queries.go:136`) — but these carry
`Code: 0`, which `json:"code,omitempty"` **drops entirely**, so `fb_error_code` is `NULL`.
SQL `= ANY` never matches `NULL`.

Net effect: a user whose send failed for *our* reason is parked in a terminal state that
is structurally unreachable by the retry path.

**This already happened.** 131 real participants, blocked 2026-07-11 → 07-14 during the
staging/production Kafka traffic leak (staging's worker queried the staging DB, which had
no production page tokens). All 131 were still `BLOCKED`, untouched, 12 days later.
Evidence: `planning/null-fb-error-code-findings.md`.

---

## The change

One file, `message-worker/worker.go`:

```go
 type MachineReportError struct {
 	Tag     string `json:"tag"`
 	Message string `json:"message"`
-	Code    int    `json:"code,omitempty"`
+	Code    int    `json:"code"`
 }

 func (w *Worker) reportError(cmd types.SendMessageCommand, err error) error {
 	tag := "STATE_ACTIONS"
 	code := 0
-	if IsPlatformError(err) {
-		tag = "FB"
-		var platformErr *PlatformError
-		if errors.As(err, &platformErr) {
-			code = platformErr.StatusCode
-		}
-	}
+
+	var platformErr *PlatformError
+	if errors.As(err, &platformErr) {
+		code = platformErr.StatusCode
+		switch {
+		case platformErr.StatusCode > 0:
+			// The provider answered and rejected us — genuinely their response.
+			// BLOCKED is correct; dean retries these via DEAN_FB_CODES.
+			tag = "FB"
+		case platformErr.Retriable:
+			// Transport failed; we never reached the provider.
+			tag = "NETWORK"
+		default:
+			// Pre-flight failure — missing token, bad config. Ours, not theirs.
+			tag = "INTERNAL"
+		}
+	}
```

**No client changes needed.** `PlatformError.Retriable` is already set correctly at every
call site: `false` for token-not-found, `true` for HTTP transport failure. The discriminator
already exists; `reportError` was just ignoring it.

### Resulting routing

| Condition | Tag | State | Retried by |
|---|---|---|---|
| `StatusCode > 0` | `FB` | BLOCKED | `DEAN_FB_CODES` (unchanged) |
| `StatusCode == 0`, `Retriable` | `NETWORK` | ERROR | `DEAN_ERROR_TAGS` |
| `StatusCode == 0`, `!Retriable` | `INTERNAL` | ERROR | `DEAN_ERROR_TAGS` |

**Verified**: `DEAN_ERROR_TAGS = "NETWORK,INTERNAL,STATE_ACTIONS"` in both
`devops/values/production.yaml:152` and `staging.yaml:152`, so both new tags are retried.

**Dropping `omitempty`** is defence in depth: after the tag fix, code `0` should not reach
the FB path at all, but if it ever does, `fb_error_code` becomes a groupable `'0'` instead
of `NULL` — and `NULL` is exactly what `= ANY` cannot match. The sql_exporter already
buckets `IS NULL OR = '0'` together as `provider_unreachable` for this reason.

### Latent bug this also closes

`messenger_client.go:111` returns `StatusCode: 0, Retriable: true` on HTTP transport
failure. Today a sustained network problem between message-worker and Meta produces the
*same* permanent codeless block as the token bug. After this change it is `NETWORK` →
`ERROR` → retried.

---

## Tests

Follow the table-driven style in `message-worker/retry_test.go`. Cover all three branches
plus the non-platform fallback:

| Input | Expect |
|---|---|
| `&PlatformError{StatusCode: 400, Retriable: false}` | `tag=FB`, `code=400` |
| `&PlatformError{StatusCode: 0, Retriable: true}` | `tag=NETWORK`, `code=0` |
| `&PlatformError{StatusCode: 0, Retriable: false}` | `tag=INTERNAL`, `code=0` |
| `errors.New("boom")` | `tag=STATE_ACTIONS`, `code=0` |

Add one marshalling assertion that the emitted JSON **contains** `"code":0` — that is the
`omitempty` regression, and it is invisible to a struct-level assertion.

Worth adding a replybot-side test too: a `machine_report` with `tag: "NETWORK"` must
produce `ERROR`, not `BLOCKED` (`replybot/lib/typewheels/machine.test.js` has the pattern
around the existing `tag: 'FB'` cases).

---

## Before shipping

- [ ] **Verify `DEAN_FB_CODES`.** I confirmed `DEAN_ERROR_TAGS` but not the FB code list,
      and the `StatusCode > 0` branch still depends on it.
- [ ] Confirm no other consumer keys off `tag == "FB"` beyond `machine.js:288`
      (`grep -rn "'FB'" replybot/ dean/ exodus/`).
- [ ] Check whether exodus or the dashboard error-message UI special-cases `FB`.

## Soak in `vstag`

- [ ] Watch the **Live Traffic** board's *Blocked by reason & page* panel: `reason="(none)"`
      should stop appearing for new blocks.
- [ ] Watch `survey_blocked_states{category="provider_unreachable"}` → should trend to 0
      for newly-updated states.
- [ ] Expect a corresponding **rise** in `survey_error_states{error_tag="INTERNAL"}` /
      `"NETWORK"` — that is the fix working, not a regression. Note
      `PlatformInternalErrors` pages at a sum of 5, so a token misconfiguration in staging
      may now legitimately alert where it used to fail silently.

---

## Explicitly NOT in scope

**The 131 already-blocked users.** This change is not retroactive — they are already
`BLOCKED` with a `NULL` code and nothing here moves them. Freeing them needs a separate
one-off remediation (state reset or targeted replay), and it is worth deciding first
whether they are still worth recovering: they were last touched 12 days ago, and 62 of the
original 193 already self-healed by messaging back in.

---

## Related

- `planning/null-fb-error-code-findings.md` — the investigation and full evidence
- `planning/staging-production-traffic-leak.md` — the incident that produced the 131
- `documentation/study-error-alerting.md#providererrors` — the runbook that surfaces this
  class, and the `provider_error` vs `provider_unreachable` split

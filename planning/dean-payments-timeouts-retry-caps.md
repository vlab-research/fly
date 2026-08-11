# Dean: cap retries on `payments` and `timeouts` queries

## Context

Dean's `payments` and `timeouts` queries have no termination condition (bug catalog: B4, B5, B6). Both are the root-cause bloat sources behind the replybot OOM:

- **`payments`** (`dean/queries.go:145-157`) fires every 6 hours for any user in `WAIT_EXTERNAL_EVENT` whose `waitStart` is between `+2h` and `+14d`. Each `repeat_payment` event triggers `MAKE_PAYMENT` in the state machine, which re-enters `WAIT_EXTERNAL_EVENT` with a fresh `waitStart` — restarting the 14-day window. The loop is effectively infinite.
- **`timeouts`** (`dean/queries.go:159-208`) fires every 10 minutes for any user past their computed timeout date, within a 72-hour past window. With production's `DEAN_TIMEOUT_BLACKLIST`, the `LIMIT 1` per-run safety doesn't apply, so all eligible users get timeouts every 10 minutes.

Worst-observed case: user `8563270007096163` accumulated 1,424 payment retries over 1.5 years, each costing real money via Reloadly.

`planning/dean-spammers-external-events-quarantine.md` indirectly stops these loops by quarantining users who reach 100 externalEvents — but only after ~25 days of wasted retries at the payments cron's 6h cadence. This plan caps the loops directly so they stop in days rather than weeks.

## Approach

Both queries already have analogous siblings (`respondings`, `errored`, `blocked`) that cap retries via `JSON_ARRAY_LENGTH(state_json->'retries') < $cap`. But that mechanism requires the state machine to populate `state.retries` for these specific event types — which it doesn't currently do for `repeat_payment` or `timeout` events.

Simpler shape: cap by `jsonb_array_length(state_json->'externalEvents')`, which directly bounds the thing we're trying to bound (state size).

## Files to modify

### `dean/queries.go`

**`Payments()` (line 145-157)**, add the externalEvents cap:

```go
func Payments(cfg *Config, conn *pgxpool.Pool) <-chan *ExternalEvent {
    query := `
              SELECT userid, pageid, state_json->>'question' as question
              FROM states
              WHERE current_state = 'WAIT_EXTERNAL_EVENT'
                AND state_json->'wait'->>'type' != 'timeout'
                AND timezone('UCT', (CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + ($1)::INTERVAL)) < $4
                AND timezone('UCT', (CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + ($2)::INTERVAL)) > $4
                AND jsonb_array_length(COALESCE(state_json->'externalEvents','[]'::jsonb)) < $3
        `
    d := time.Now().UTC()
    return get(conn, getPayment, query, cfg.PaymentGrace, cfg.PaymentInterval, cfg.PaymentMaxAttempts, d)
}
```

**`Timeouts()` (line 159-208)**, add the externalEvents cap to the outer SELECT:

```go
// after the existing CTEs, in the final SELECT:
SELECT waitStart, userid, pageid
FROM timeout_dates
JOIN states USING (userid)
WHERE
  calculated_timeout_date < $1
  AND calculated_timeout_date > $1 - ($2)::INTERVAL
  AND jsonb_array_length(COALESCE(states.state_json->'externalEvents','[]'::jsonb)) < $3
```

(Adjust the join carefully — the existing CTE already joins states. May not need a second join; just reference `s.state_json` from the inner CTE.)

### `dean/dean.go` (Config + env loading)

Add to `Config` struct:

```go
PaymentMaxAttempts int
TimeoutMaxAttempts int
```

Parse from env, following the existing `RetryMaxAttempts` pattern:

```go
PaymentMaxAttempts: mustParseInt(os.Getenv("DEAN_PAYMENT_MAX_ATTEMPTS")),
TimeoutMaxAttempts: mustParseInt(os.Getenv("DEAN_TIMEOUT_MAX_ATTEMPTS")),
```

### `dean/queries_test.go`

Add tests for both queries:
- `Payments` does NOT return user with externalEvents at or above cap.
- `Payments` DOES return user below cap with otherwise matching window/state.
- `Timeouts` analogous tests.
- Existing test cases still pass.

### `devops/values/production.yaml`

Add to `dean.env` block:

```yaml
- name: DEAN_PAYMENT_MAX_ATTEMPTS
  value: "30"
- name: DEAN_TIMEOUT_MAX_ATTEMPTS
  value: "5"
```

Mirror in `devops/values/staging.yaml`.

## Threshold rationale

**Payments: 30**. Each retry costs real Reloadly money. Most failures are terminal (bad number, wrong operator, no funds), but some are transient (Reloadly outages, operator network issues, balance-top-up timing). 30 attempts at 6h cadence = ~7.5 days of trying — generous enough to ride out a multi-day outage, bounded enough that wasted spend per stuck user is capped at 30 calls instead of unbounded. If real-world Reloadly success-after-N-failures data suggests a different cap, tune accordingly.

**Timeouts: 5**. Timeouts are nudges. If a user has ignored 5 already (over up to ~50 minutes at 10-min cadence), they're not coming back this session. Lower than payments because there's no per-attempt cost.

These are the cheapest-to-tune knob; safe to start conservative.

## Interaction with the spammers plan

This plan and `dean-spammers-external-events-quarantine.md` are complementary:

- This plan stops the loops at the source (10 retries instead of 100+).
- Spammers plan still catches edge cases (other bloat sources, misconfigured surveys, manual operations).
- Both can ship independently in either order.

After both are deployed, a stuck payment user would:
1. Get 30 retries over ~7.5 days (capped here).
2. Stop getting `repeat_payment` events; state stays `WAIT_EXTERNAL_EVENT` indefinitely.
3. Eventually crosses 100 externalEvents threshold (only if other sources keep adding; might not happen now).
4. If it does, spammers catches them.

Net: 30 wasted Reloadly calls per stuck user instead of unbounded.

## Verification

1. Dean unit tests pass with new test cases.
2. Local integration: seed states rows in `WAIT_EXTERNAL_EVENT` with varying externalEvents counts; run `Payments()` and assert only those below cap are returned.
3. Staging deploy: confirm env vars set; watch Dean payments logs for ~24h; verify previously-runaway users (if any in staging) stop receiving retries after their cap.
4. Production deploy: deploy after the spammers plan has stabilized. Watch Dean metrics for the drop in `repeat_payment` event volume — should be visible within 6 hours.

## Sequencing

Independent of the spammers plan, but recommended order:
1. Deploy spammers plan first (catches existing stuck users now).
2. Deploy this plan second (prevents future stuck users from accumulating).

Either order works. Bigger-bang results from doing both.

## What this plan does NOT fix

- Already-bloated state for stuck users — pointer triage from the spammers plan handles those.
- The state machine appending to externalEvents on every event regardless of state (bug B7). Out of scope.
- The `waitStart` reset on each retry (bug B5) — not directly fixed but capping makes it irrelevant.
- machine_report state embedding (bug B8) — separate investigation.

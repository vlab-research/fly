# Conversation identity — test inventory

**Last full pass: 2026-08-20.** Rewritten on that date from a *specification* (what should be
written) into an *inventory* (what exists, how to run it, what it does not cover). The old
document's §0.9 corrections chain and the removed registry's §B11 are gone; see git history.

Companion to `planning/conversation-identity.md`.

---

## 1. Run everything

```bash
# replybot — 636 tests
cd replybot && npm test

# hermes — 39 tests
cd hermes && cargo test

# scribble, message-worker, dean, …
go test ./...

# the backfill — 24 tests, needs a database
make -C devops test-db PORT=5455
TEST_DATABASE_URL=postgres://root@localhost:5455/chatroach go test ./devops/backfill/...

# the integration harness — testcontainers, slow
cd facebot/testrunner && npm test
```

All green as of 2026-08-20.

---

## 2. What covers what

### The derivation rule — three languages, one fixture

`testdata/event-envelope/messenger-account-derivation.json` holds 12 vectors and is the single
specification for "which id is the account and which is the participant". Three implementations
assert it, so none can drift:

| | Where | Shape |
|---|---|---|
| Rust | `hermes/src/event.rs` | one `#[test]` per vector, plus `every_vector_is_covered`, which fails if a vector is added without a test |
| Go | `scribble/account_test.go` `TestBackfillSQLMatchesGo` | subtests; evaluates the real `devops/sql/*-expr.sql` files against the fixture and asserts they agree with `ConversationFromHistoricalContent` |
| JS | `replybot/lib/event-normalizer.test.js` | one `it()` per vector |

Drift-verified in Go and Rust: inverting `is_echo` fails exactly the echo vectors.

**Backtested against production** (2026-08-20, read-only, not a repo test): 182,057 real
Messenger rows for single-account participants, zero disagreements; the inverted rule disagrees
100%. Method and numbers in `planning/conversation-identity.md` §3.1.

### The cache key — `replybot/lib/typewheels/statestore.js`

`replybot/lib/typewheels/statestore.test.js`, 25 tests.

| | |
|---|---|
| B10-1 | keys on the full triple, not the user alone |
| B10-2 | two accounts, same platform, same user → two distinct keys — **the unit-level regression test for the whole bug**; also asserted on the read and write paths separately |
| B10-3 | same account id on two platforms → two distinct keys. **Load-bearing prospectively**: the intended design is that a `facebook_page` credential also serves Instagram, i.e. one page id carrying both `messenger` and `instagram` conversations. No code change today — Instagram has no inbound path (`event-normalizer.js` has only Messenger and WhatsApp parsers; there is no `instagram` credentials entity). |
| B10-9a/b/c | replay scoping: right user *and* right account; account-without-platform still scopes; no account passes `{ userid, account: null }` **explicitly** |

The B10-9 tests assert the **arguments** `db.get` receives, not merely that it was called —
asserting `.called` alone would pass against a completely unscoped replay, which is the one thing
this phase must guarantee.

### The replay query — `replybot/lib/chatbase/chatbase.js`

`replybot/lib/chatbase/chatbase.test.js`. Covers the account-scoped `WHERE`, the
`OR account_id IS NULL` migration-window branch, and that only *this* account's
`message_pointer` applies.

### The refusals — `replybot/lib/typewheels/`

`machine.test.js` and `transition.test.js`. Both refusals return `_noop()`:

- synthetic event at `START` → no message, no form, state unchanged
- form-less entry on a live conversation → live conversation returned exactly as it went in

`transition.test.js` also pins that a Messenger **handover** on the same empty state still
blank-starts, and that the refusal short-circuits before the form lookup and the send.

### The envelope guard — `message-worker/`

`envelope_test.go`. `MissingEnvelopeFields` is total (never panics on any input), treats an
empty string and an object-valued `platform` as missing, and the `WhatsAppEcho` builder is
asserted byte-for-byte.

### The backfill — `devops/backfill/`

24 tests. 10 unit (the statements we build), 14 integration against a real CockroachDB.

Integration coverage: every real shape, poison resilience (a malformed-JSON row must not kill
its batch), idempotency, resumability, restart-from-scratch, coverage at five batch sizes, an
empty table, awkward userids surviving the cursor, a forward-written row arriving mid-run,
`--dry-run` writing nothing, and `--rehearse` executing the real statement while persisting
nothing and reporting the same count the real run writes.

**Mutation-checked** — the suite is known to fail when the code is wrong:

| Mutation | Result |
|---|---|
| drop `AND account_id IS NULL` | 3 tests fail, incl. "a second run updated 6 rows; it must update none" and "the backfill clobbered a forward-written account" |
| batch upper bound `<=` → `<` | 4 tests fail, incl. rows silently skipped — the failure mode that matters, since a skipped row is never revisited |

One test pins a **known, deliberate gap**:
`TestARowWithNoDerivableAccountIsSkippedEvenIfItsPlatformWasDerivable`. The batch predicate is
`(<account>) IS NOT NULL`, so a row whose account is not derivable is skipped whole — even when
its platform would have been. Measured empty on production (of 300,000 sampled rows, 9 are
synthetic-with-no-page and **zero** carry a platform), so the alternative — a fourth evaluation
of the expressions on a 384 GiB column — buys nothing. **If that test ever fails, the gap has
opened and the predicate needs revisiting.**

### End to end — `facebot/testrunner/test.tc.ts`

Testcontainers: real replybot, hermes, scribble, dean, CockroachDB, Redis, Kafka.

Implemented: **B1-1…B1-4** (conversation isolation, incl. cross-platform same user id),
**B2-1, B2-2** (the §1.1 reproduction verbatim — B2-1 is the ship gate), **B3-1, B3-2**
(cross-researcher containment), **B8-1…B8-6** (replay and the `message_pointer` leak),
**B10-4, B10-5, B10-8** (missing-tuple behaviour, incl. that an unattributable event still
advances the conversation rather than erroring).

---

## 3. Harness limitations worth knowing

- **Every row is written by current code.** The harness is a fresh database, so it cannot
  produce *historical* rows. Anything about pre-migration data — the backfill's real-shape
  behaviour, poison rows, un-backfilled replay — has to be tested where the rows can be
  fabricated deliberately, which is `devops/backfill/integration_test.go`. A version in the
  harness would fabricate rows anyway, from further away, with a worse failure signal.
- **The forward/backward overwrite seam does not exist**, so there is no test for it:
  `devops/backfill`'s `UpdateQuery` carries `AND account_id IS NULL`, so forward-written rows
  are excluded by construction. Asserted directly by
  `TestBackfillNeverOverwritesAForwardWrittenAccount`. **This reasoning is void if the backfill
  ever gains a branch that writes over a non-NULL `account_id`.**
- **Schema comes from `devops/migrations/*.sql` concatenated into one session.** Any migration
  must use fully-qualified `chatroach.` names or it aborts every migration after it. Migrations
  18 and 19 are *not* on this branch (they live untracked in the primary worktree), so the
  harness builds `messages` with indexes production no longer serves.

---

## 4. Not covered

| Gap | Why |
|---|---|
| **Rate of either refusal in production** | Neither emits a log tag any more (deliberate, 2026-08-20). Use the `states` detector queries in `documentation/referral-form-resolution.md`; there is no positive signal that the guard is being reached. |
| **`platform` on `responses` / `chat_log`** | Columns exist, nothing writes them, so nothing asserts them. |
| **The rollout itself** | Migrations 27/28 against a live `responses` table, and the scribble `ON CONFLICT` mismatch, cannot be tested in the harness — the harness applies all migrations before starting anything. See `planning/conversation-identity.md` §5.1; rehearse on staging. |
| **Instagram** | No inbound path exists, so B10-3 guards a case that cannot yet arise. |

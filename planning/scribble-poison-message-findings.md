# Scribble: a poison message wedges a sink indefinitely

**Found:** 2026-07-25, while verifying the staging deploy.
**Status:** not fixed. The sink is currently healthy, but the defect is live in
both staging and production.

## Summary

`gbv-scribble-responses` accumulated **348 restarts**. A single Kafka message
whose `surveyid` had no matching row in `surveys` failed its INSERT on a
foreign-key constraint. Scribble returns that error, the process exits, the
Kafka offset is never committed, Kubernetes restarts the pod, it re-consumes
the same message, and it dies again — indefinitely.

It is healthy now only because the message stopped being redelivered. Nothing
was fixed.

## Evidence

Pod `gbv-scribble-responses-7d6568cffb-h62ht`, image `vlabresearch/scribble:v0.0.32`:

```
restartCount = 348
lastState.terminated = { exitCode: 1, reason: "Error",
                         finishedAt: "2026-07-13T21:28:11Z" }
state.running.startedAt = "2026-07-13T21:29:37Z"
```

Logs from the final crashed container:

```
2026/07/13 21:28:11 Consumed 1 messages as batch from Kafka
2026/07/13 21:28:11 Scribble failed with error: ERROR: insert on table "responses"
                    violates foreign key constraint "responses_surveyid_fkey"
                    (SQLSTATE 23503)
```

The restarts are **not ongoing**: they ended 2026-07-13 and the pod has been up
continuously for 12 days. An earlier reading of this as "~29 restarts/day" was
wrong — it divided the total by pod age. It was one burst, then silence.

The other three sinks are comparatively untouched: `chat-log` 4 restarts,
`messages` 2, `states` 2.

## Root cause

`scribble/write.go`:

```go
func Write(v *validator.Validate, scribbler Scribbler, messages []*kafka.Message, strictMode bool) error {
	data, err := Prep(scribbler.Marshal, messages)
	if err != nil {
		return err                       // (1) marshal failure -> fatal
	}

	validData := []Writeable{}
	for _, d := range data {
		err := v.Struct(d)
		if err != nil {
			if strictMode {
				return err               // (2) validation failure -> fatal
			}
			log.Printf("Validation error for record: %v", err)
			continue                     // ...or skipped, when lenient
		}
		validData = append(validData, d)
	}

	if len(validData) == 0 {
		return nil
	}

	return scribbler.SendBatch(validData)   // (3) DB failure -> ALWAYS fatal
}
```

### The important subtlety: `SCRIBBLE_STRICT_MODE` does not protect against this

There is already a leniency knob, and the responses sink already has it off:

| sink | `SCRIBBLE_STRICT_MODE` |
|---|---|
| states | false |
| **responses** | **false** |
| messages | true |
| chat-log | false |

It crashed anyway, because `strictMode` guards **only Go struct validation**
(step 2). The foreign-key violation happens at step 3, inside `SendBatch` —
the database write — whose error is returned **unconditionally**, with no
leniency path at all.

So the configuration reads as "this sink tolerates bad records" while in fact
it tolerates only records that are malformed in shape. A record that is
perfectly well-formed but references a row that does not exist still takes the
whole process down. That gap is the bug.

## Why it stopped without intervention

Not verified — the message is long gone. Two plausible explanations:

1. the offending message aged out of Kafka retention
   (`vlab-staging-response`, `retention.ms` = 31 days), or
2. the missing `surveys` row was created later, so the FK finally resolved.

Either way it resolved by external circumstance, not by the code handling it.
The same message today would wedge the sink again.

## Blast radius

- **Production runs the same version.** `versionScribble: v0.0.32` in both
  `devops/values/staging.yaml` and `devops/values/production.yaml`. Nothing
  about this is staging-only.
- **Not fixed by this release.** Scribble was not rebuilt — its only changes
  across `66eb4fd1..0733198c` were `chatlog_test.go` and `test_helpers.go`.
- **A wedged responses sink is silent data loss in slow motion.** Responses
  stop landing in CockroachDB while Kafka retains them, so recovery is
  possible — until retention expires, at which point the gap is permanent.
- Any `surveys`-row-missing scenario reproduces it. Ordering matters: a
  response that arrives before its survey row is written is enough.

## This is the third instance of one pattern

Three services, three mechanisms, one shape — **one bad unit of work blocks all
subsequent work, and only an external event clears it**:

| service | mechanism | clears by |
|---|---|---|
| scribble | poison message, no dead-letter, offset never commits | Kafka retention expiry |
| exodus executor | poison Job in ImagePullBackOff + `concurrencyPolicy: Forbid` | manual `kubectl delete job` (done 2026-07-25) |
| message-worker | burrow `FatalOnError` -> `os.Exit(1)` on any non-nil error | manual intervention |

message-worker is the one that now has a real answer: `HandledError`
(`22aefe94`) lets a *handled* failure commit its offset instead of killing the
consumer. Scribble has no equivalent.

## Alerting gap

348 restarts over roughly two hours notified nobody. The Karma + ntfy alerting
that would catch `KubePodCrashLooping` exists but is **unreleased** — it sits
in commit `94375e98` on local `main`, never pushed. Shipping it would convert
this class of failure from "discovered by accident twelve days later" to a
phone notification.

## Proposed fix

Give DB write failures the same leniency path validation errors already have,
but do it deliberately — the current knob's semantics are already misleading.

1. **Distinguish constraint violations from infrastructure failures.** A
   `23503` (FK) or `23505` (unique) violation is a bad *record*: skipping it is
   correct. A connection failure is a bad *world*: crashing is correct, because
   retrying is the right behaviour. Discriminate on `pgconn.PgError.Code`
   rather than treating all `SendBatch` errors alike.
2. **Dead-letter the offending record** — log it in full and, ideally, publish
   it to a dead-letter topic so nothing is silently dropped. Then commit the
   offset and continue.
3. **Split the batch on failure.** `SendBatch` fails as a unit, so one poison
   record currently discards its whole batch. Retry record-by-record to isolate
   the offender and preserve its innocent neighbours.
4. **Rename or re-scope `SCRIBBLE_STRICT_MODE`.** Whatever is implemented, the
   flag should not keep implying it covers write errors when it does not.

## Explicitly not done

- No scribble code was changed. It is unrelated to this release and the sink is
  currently healthy; fixing it under deploy pressure was not warranted.
- The exact poison message was not recovered — it is past retention.
- Whether other sinks have ever hit the same path was not investigated; their
  low restart counts suggest not, but that is inference, not evidence.

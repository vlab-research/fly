# Scribble

Scribble is a Kafka-to-CockroachDB sink service. It consumes messages from Kafka topics and writes them to corresponding database tables in batch. Each deployment instance is configured with a single **destination** that determines which table it writes to and how it deserializes incoming Kafka messages.

## Architecture

Scribble follows a plugin-style architecture with a common framework and per-destination scribblers:

```
Kafka topic --> spine.KafkaConsumer --> Writer (validate + batch) --> Scribbler.SendBatch --> CockroachDB
```

### Core Components

| File | Purpose |
|------|---------|
| `scribble.go` | Entry point. Reads config, selects the correct Scribbler by destination name, runs the consume-write loop. |
| `write.go` | Defines the `Scribbler` and `Writeable` interfaces. Orchestrates marshalling, validation, and batch writing. |
| `utils.go` | SQL query building helpers (`SertQuery`, `Placeholders`) and custom JSON types (`JSTimestamp`, `CastString`). |
| `errors.go` | Error handling and forwarding to configurable error handler topics. |

### Scribbler Interface

Every destination implements the `Scribbler` interface:

```go
type Scribbler interface {
    SendBatch([]Writeable) error
    Marshal(*kafka.Message) (Writeable, error)
}
```

- **`Marshal`** -- Deserializes a single Kafka message into a `Writeable` struct (which provides `GetRow() []interface{}` for column values).
- **`SendBatch`** -- Takes a batch of validated `Writeable` records and executes a bulk INSERT/UPSERT into the target table.

### Destinations

| Destination | File | Table | Conflict Strategy |
|-------------|------|-------|-------------------|
| `states` | `state.go` | `states` | `UPSERT` (last write wins, deduped by `(userid, pageid)`) |
| `responses` | `response.go` | `responses` | `ON CONFLICT(userid, pageid, timestamp, question_ref) DO NOTHING` |
| `messages` | `message.go` | `messages` | `ON CONFLICT(hsh, userid) DO NOTHING` |
| `chat_log` | `chatlog.go` | `chat_log` | `ON CONFLICT(userid, pageid, timestamp, direction) DO NOTHING` |

Every one of those keys is a **conversation** key, not a participant key — see
below. `messages` looks like the exception and is not: its key is
account-scoped *transitively*, because `hsh` is `fnv64a(content)` and the account
is inside `content`. That is explained under
[`messages` carries the account](#messages-carries-the-account-and-the-platform).

### A row's identity is the conversation, not the participant

A conversation is `(platform, account_id, user_id)`. A user id alone is not an
identity: the same person can hold a live conversation on every messaging account
we run, and on WhatsApp they always can, because `wa_id` is their phone number and
is identical across every business number they message. In these tables the
account is the legacy column name `pageid`.

Three of scribble's four sinks used to key on the user id alone. None of them
raised an error when a participant appeared on two accounts — they **silently
discarded** the second row:

| Sink | Old key | What was lost |
|---|---|---|
| `states` | `DedupStates` mapped on `UserID` | a batch holding one participant's state on two accounts kept one and dropped the other, before the write ever reached the database |
| `responses` | `ON CONFLICT(userid, timestamp, question_ref)` | an answer given on a second account at the same instant |
| `chat_log` | `ON CONFLICT(userid, timestamp, direction)` | a message on a second account **in the same second** — the widest window of the three |

Widening the two `ON CONFLICT` targets is not a code-only change. The old targets
**were the primary keys** of `responses` and `chat_log`, so:

- Naming columns the primary key does not cover raises `42P10 there is no unique
  or exclusion constraint matching the ON CONFLICT specification` on every write.
- Adding a bare unique index while leaving the old primary key in place is *worse*
  than the original bug: the second row clears the arbiter, reaches the primary
  index, and raises `23505`. Since `scribble.go`'s `checkError` is a `log.Fatalf`,
  a write error is not a dropped row — it is a **crash loop**.

`devops/migrations/27-chat-log-account-scoped-key.sql` and
`28-responses-account-scoped-key.sql` fold `pageid` into those primary keys.
**Both must be applied before the matching scribble build is deployed.** Migration
28 additionally requires `devops/backfill-responses-pageid.sh` to have been run to
completion first; its own guard refuses to proceed otherwise.

#### `pageid` is NOT NULL

An identity component has no null, and CockroachDB refuses a nullable column in a
primary key outright (`42P15`). Both `pageid` columns are therefore `NOT NULL`, and
the empty string is the **"account unknown" sentinel** the migrations backfilled the
historical NULLs to.

**Neither column has a DEFAULT**, and that is deliberate. A default applies to
future INSERTs, so it would hand "account unknown" to any writer that merely forgot
the column — silently mis-attributing a row, which is the exact bug class these
migrations exist to remove. Omitting `pageid` raises `23502` instead.
`states.pageid`, the table that already keys on the conversation, is likewise `NOT
NULL` with no default.

The `''` sentinel is written only where we have *decided* the account is unknown, not
wherever a caller is careless: `chatlog.go`'s `accountOrUnknown` maps a nil `Pageid`
to `''`, and `response.go` no longer converts an empty `Pageid` back into SQL NULL.
Both are explicit, tested, and cover a measured producer gap.

That coercion is not theoretical. Replybot omitted the account on roughly **0.9%**
of chat log entries (395 of the last 43,824 rows written; 14,834 in total). Since
scribble treats any write error as fatal, a `NOT NULL` column plus an
account-less entry would otherwise be a crash loop.

#### Why `messages` is different from `responses` and `chat_log`

Two reasons, and both matter.

**The stakes are different.** A row dropped from `responses` *was a participant's
answer* — it is gone, and no later process can reconstruct it. A row dropped from
`messages` costs an *event in replay*: the archive is a log, and the conversation
state derived from it is recomputed rather than authoritative. That asymmetry is
why migrations 27 and 28 were worth an `ALTER PRIMARY KEY` on the two live tables
and `messages` was not.

**The key was already account-scoped.** `hsh` is a stored computed column,
`fnv64a(content)` (`01-init.sql:22`), so it hashes the whole event body — and the
account identifier is *inside* that body in every shape: `phone_number_id`
(WhatsApp), `recipient.id`/`sender.id` (Messenger), `page` (synthetic), and now
also the normalized top-level `account_id`. Two events on two accounts therefore
cannot collide on `(hsh, userid)`: the bytes that distinguish the accounts are
among the bytes being hashed.

So `ON CONFLICT(hsh, userid)` **stays**. Widening it to
`(hsh, userid, account_id)` would have meant `ALTER PRIMARY KEY` on a 384 GiB
table — the largest in the system, ~88% of all data — to eliminate only the
*cross-account* subset of `fnv64a` collisions, while leaving same-account
collisions (the overwhelmingly larger population) untouched. The full argument and
the measured disk numbers are in the header of
`devops/migrations/26-messages-account.sql`.

One useful consequence: because the conflict target is unchanged, **the `messages`
sink has no schema-then-code deploy ordering requirement.** Old and new scribble
builds both run against both schemas, in either order. That is the opposite of
`chatlog.go` and `response.go`.

### `messages` carries the account and the platform

`messages` now has nullable `account_id` and `platform` columns
(`devops/migrations/26-messages-account.sql`). `message.go` reads both from the
**event envelope's normalized top-level fields** — see
`documentation/event-envelope.md`. It is the only place scribble parses the
`messages` body, and it reads *nothing else*: no per-shape extraction, no
fallback to `source`, no fallback to `md`. A producer that stops stamping the
fields must fail visibly rather than be silently papered over.

Both columns are **nullable and unvalidated**, deliberately. Scribble treats any
write error as fatal, so a required identity would let a missing envelope field
crash-loop the archival consumer and archive nothing. The row is the evidence: it
is stored either way, with an unknown identity recorded honestly as `NULL`.

This is also why `messages` does *not* use the empty-string "account unknown"
sentinel that `chat_log` and `responses` need. Their `pageid` is part of a primary
key and cannot be null; `messages` keeps `PRIMARY KEY (hsh, userid)`, so
`account_id` stays nullable and can say "unknown" truthfully instead of grouping
every unattributable event under one fake account.

#### The historical backfill

Rows archived before hermes stamped the normalized fields carry the account only
under its per-shape name. The envelope work kept those fields in place precisely
so the backfill and the forward path read the same source.

- `devops/backfill-messages-account.sh` — batched, idempotent, interruptible, and
  resumable. It walks the primary key with a cursor rather than filtering on
  `account_id IS NULL`, because that predicate is not an index prefix and the
  final batches would otherwise scan the whole table to find nothing.
- `devops/sql/messages-account-id-expr.sql` and `messages-platform-expr.sql` — the
  extraction rule, as **one** SQL expression each. The backfill substitutes them,
  and `TestBackfillSQLMatchesGo` evaluates the same two files against the shared
  cross-language fixture `testdata/event-envelope/messenger-account-derivation.json`
  and asserts they agree with `ConversationFromHistoricalContent` in `account.go`.
  Drift between the SQL and the Go is a test failure.

The backfill is **not** a prerequisite for the migration, which is the opposite of
the arrangement in 27/28. Because `account_id` stays nullable, the order is schema
first, read path second, backfill last and at leisure — and the read path in
`replybot/lib/chatbase` tolerates `NULL account_id` for the duration.
See that module's `get()` for the removal gate.

A small tail of rows is **permanently unattributable** — synthetic events that
carry no account at all (3 in a uniform 200,000-row production sample) plus any
malformed `content`. A plain count of `NULL account_id` therefore never reaches
zero, and should not.

### Adding a New Destination

1. Create a new Go file (e.g., `mydata.go`) with:
   - A struct implementing `Writeable` (with `GetRow()`)
   - A struct implementing `Scribbler` (with `Marshal` and `SendBatch`)
   - A constructor `NewMyDataScribbler(pool *pgxpool.Pool) Scribbler`
2. Add the destination to the `marshallers` map in `scribble.go`
3. Configure the Helm deployment with the appropriate `SCRIBBLE_DESTINATION` env var

## Chat Log Scribbler

The `chat_log` destination (`chatlog.go`) writes conversation messages (both bot-sent and user-sent) to the `chat_log` table. It consumes from a dedicated Kafka topic where replybot publishes chat log entries.

### ChatLogEntry Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userid` | `string` | Yes | Chat respondent (Facebook PSID) |
| `pageid` | `*string` | No on the wire, `NOT NULL` in the column | Messaging account id (page id / phone number id). Part of the primary key; an absent value is written as the `''` "account unknown" sentinel, never NULL |
| `timestamp` | `*JSTimestamp` | Yes | When the message was sent/received |
| `direction` | `string` | Yes | `"bot"` or `"user"` |
| `content` | `string` | Yes | Human-readable message text |
| `question_ref` | `*string` | No | Typeform question reference ID |
| `shortcode` | `*string` | No | Survey form shortcode |
| `surveyid` | `*string` | No | Survey version UUID |
| `message_type` | `*string` | No | Free text type (e.g., `"text"`, `"quick_reply"`, `"postback"`) |
| `raw_payload` | `json.RawMessage` | No | Full Facebook API event payload |
| `metadata` | `json.RawMessage` | No | State machine metadata snapshot |

Nullable fields use pointer types (`*string`) so they serialize as SQL NULL when
absent from the Kafka message JSON. `pageid` is the exception: it stays a `*string`
on the struct, because replybot does sometimes omit it, but `GetRow` runs it through
`accountOrUnknown` so the column never receives NULL. See
[A row's identity is the conversation](#a-rows-identity-is-the-conversation-not-the-participant).

## Configuration

All configuration is via environment variables:

| Variable | Description |
|----------|-------------|
| `CHATBASE_DATABASE` | CockroachDB database name |
| `CHATBASE_USER` | Database user |
| `CHATBASE_PASSWORD` | Database password |
| `CHATBASE_HOST` | Database host |
| `CHATBASE_PORT` | Database port |
| `KAFKA_BROKERS` | Kafka broker addresses |
| `KAFKA_POLL_TIMEOUT` | Kafka consumer poll timeout |
| `KAFKA_TOPIC` | Kafka topic to consume from |
| `KAFKA_GROUP` | Kafka consumer group ID |
| `SCRIBBLE_BATCH_SIZE` | Number of messages per batch write |
| `SCRIBBLE_CHUNK_SIZE` | Number of messages per consumer poll chunk |
| `SCRIBBLE_DESTINATION` | Which scribbler to use (`states`, `responses`, `messages`, `chat_log`) |
| `SCRIBBLE_ERROR_HANDLERS` | Error handler configuration |
| `SCRIBBLE_STRICT_MODE` | If `true`, validation errors are fatal; if `false`, invalid records are skipped with a log warning |

## Local Development

```bash
# Run with dev configuration
./dev.sh
```

## Testing

Most of `scribble`'s tests are integration tests: they write real rows to a real
CockroachDB and read them back, because the behaviour under test *is* the SQL. Only
the `Marshal`, `GetRow`, `DedupStates`, `Placeholders` and error-handler tests are
pure unit tests.

```bash
# Bring up a database with every migration applied (publishes port 5433)
make -C ../devops test-db

go test ./...
```

`testPool()` connects to `postgres://root@localhost:5433/chatroach` by default and
honours **`TEST_DATABASE_URL`** as an override — the same escape hatch
`exodus/query`'s integration tests use. Prefer it over `make test-db` when a
database may already be running on the default port, since that target begins with
`docker stop && docker rm vlab-cockroach` and will tear down whatever is there:

```bash
TEST_DATABASE_URL="postgres://root@localhost:5439/chatroach" go test ./...
```

The database must have migrations 27 and 28 applied, or every `responses` and
`chat_log` write fails with `42P10`.

**Not covered here:** the `facebot/testrunner` testcontainers harness runs only the
`states` and `responses` sinks (`facebot/testrunner/stack.ts`; `scribble/kube-dev/`
holds only those two manifests). The `chat_log` and `messages` sinks have no
end-to-end coverage, so `scribble/chatlog_test.go` is their only test.

## Dependencies

- `github.com/confluentinc/confluent-kafka-go/v2` -- Kafka consumer
- `github.com/jackc/pgx/v4` -- PostgreSQL/CockroachDB driver
- `github.com/vlab-research/spine` -- Kafka consumer wrapper
- `github.com/go-playground/validator/v10` -- Struct validation
- `github.com/dgraph-io/ristretto` -- In-memory cache (used by ResponseScribbler for translation)
- `github.com/vlab-research/trans` -- Translation support (ResponseScribbler only)

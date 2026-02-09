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
| `states` | `state.go` | `states` | `UPSERT` (last write wins, deduped by userid) |
| `responses` | `response.go` | `responses` | `ON CONFLICT(userid, timestamp, question_ref) DO NOTHING` |
| `messages` | `message.go` | `messages` | `ON CONFLICT(hsh, userid) DO NOTHING` |
| `chat_log` | `chatlog.go` | `chat_log` | `ON CONFLICT(userid, timestamp, direction) DO NOTHING` |

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
| `pageid` | `*string` | No | Facebook page ID |
| `timestamp` | `*JSTimestamp` | Yes | When the message was sent/received |
| `direction` | `string` | Yes | `"bot"` or `"user"` |
| `content` | `string` | Yes | Human-readable message text |
| `question_ref` | `*string` | No | Typeform question reference ID |
| `shortcode` | `*string` | No | Survey form shortcode |
| `surveyid` | `*string` | No | Survey version UUID |
| `message_type` | `*string` | No | Free text type (e.g., `"text"`, `"quick_reply"`, `"postback"`) |
| `raw_payload` | `json.RawMessage` | No | Full Facebook API event payload |
| `metadata` | `json.RawMessage` | No | State machine metadata snapshot |

Nullable fields use pointer types (`*string`) so they serialize as SQL NULL when absent from the Kafka message JSON.

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

## Dependencies

- `github.com/confluentinc/confluent-kafka-go/v2` -- Kafka consumer
- `github.com/jackc/pgx/v4` -- PostgreSQL/CockroachDB driver
- `github.com/vlab-research/spine` -- Kafka consumer wrapper
- `github.com/go-playground/validator/v10` -- Struct validation
- `github.com/dgraph-io/ristretto` -- In-memory cache (used by ResponseScribbler for translation)
- `github.com/vlab-research/trans` -- Translation support (ResponseScribbler only)

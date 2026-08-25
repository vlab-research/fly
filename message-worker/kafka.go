package messageworker

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/vlab-research/fly/message-worker/types"
	"go.uber.org/zap"
)

// KafkaProducer implements EventProducer using Kafka
type KafkaProducer struct {
	producer *kafka.Producer
	topic    string
	logger   *zap.Logger

	// strictEnvelope turns the envelope guard from "report" into "refuse".
	// DEFAULT OFF -- see guardEnvelope for why the default is the safe one.
	strictEnvelope bool
}

// WithStrictEnvelope makes the envelope guard refuse to publish an event that
// lacks a complete conversation identity, instead of reporting it and
// publishing anyway. Off by default; wired from STRICT_EVENT_ENVELOPE.
//
// This is the same rollout ladder the rest of the conversation-identity work
// uses -- hermes' SYNTHETIC_REQUIRE_CONVERSATION, replybot's
// STRICT_EVENT_PLATFORM: ship the counter, watch it read zero, then flip the
// enforcement in a committed values file.
func (kp *KafkaProducer) WithStrictEnvelope(strict bool) *KafkaProducer {
	kp.strictEnvelope = strict
	return kp
}

// NewKafkaProducer creates a new Kafka event producer
func NewKafkaProducer(brokers []string, topic string, logger *zap.Logger) (*KafkaProducer, error) {
	config := &kafka.ConfigMap{
		"bootstrap.servers": joinStrings(brokers, ","),
		"acks":              "all",
		"retries":           10,
		"max.in.flight.requests.per.connection": 5,
		"compression.type":                      "snappy",
	}

	producer, err := kafka.NewProducer(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create kafka producer: %w", err)
	}

	return &KafkaProducer{
		producer: producer,
		topic:    topic,
		logger:   logger,
	}, nil
}

// PublishEvent sends an event to Kafka using the configured topic
func (kp *KafkaProducer) PublishEvent(ctx context.Context, event types.UniversalEvent) error {
	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("failed to marshal event: %w", err)
	}

	// Use conversation_id as key for partitioning
	m, err := kp.publish(ctx, event.ConversationID, data)
	if err != nil {
		return err
	}

	kp.logger.Debug("event delivered",
		zap.String("event_id", event.EventID),
		zap.String("event_type", event.EventType),
		zap.Int32("partition", m.TopicPartition.Partition),
		zap.Int64("offset", int64(m.TopicPartition.Offset)))
	return nil
}

// PublishRawEvent sends pre-serialized event bytes to the configured topic
// under the given partition key (used for replybot-shaped events like the
// WhatsApp send echo, whose JSON differs from types.UniversalEvent).
func (kp *KafkaProducer) PublishRawEvent(ctx context.Context, key string, value []byte) error {
	_, err := kp.publish(ctx, key, value)
	return err
}

// publish is the single point at which this service writes anything to the
// event topic (KAFKA_EVENT_TOPIC, `chat-events`). Both exported publish methods
// funnel through it, which is what makes the envelope guard a chokepoint rather
// than a convention a new caller can forget: a future direct producer inside
// message-worker gets checked whether or not its author has read this file.
//
// The guard belongs HERE rather than in PublishRawEvent because PublishRawEvent
// is not the only door. types.UniversalEvent goes out through PublishEvent and
// carries no top-level identity at all, so guarding only the raw path would
// leave the shape with the worse violation unguarded.
func (kp *KafkaProducer) publish(ctx context.Context, key string, value []byte) (*kafka.Message, error) {
	if err := kp.guardEnvelope(key, value); err != nil {
		return nil, err
	}

	topicName := kp.topic
	msg := &kafka.Message{
		TopicPartition: kafka.TopicPartition{
			Topic:     &topicName,
			Partition: kafka.PartitionAny,
		},
		Key:   []byte(key),
		Value: value,
	}

	deliveryChan := make(chan kafka.Event)
	if err := kp.producer.Produce(msg, deliveryChan); err != nil {
		return nil, fmt.Errorf("failed to produce message: %w", err)
	}

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case e := <-deliveryChan:
		m := e.(*kafka.Message)
		if m.TopicPartition.Error != nil {
			return nil, fmt.Errorf("delivery failed: %w", m.TopicPartition.Error)
		}
		return m, nil
	}
}

// guardEnvelope refuses or reports an event published to chat-events without a
// complete conversation identity. The decision (MissingEnvelopeFields) is pure
// and lives in envelope.go; this is only the shell that logs and, optionally,
// declines.
//
// It REPORTS by default and REFUSES only under STRICT_EVENT_ENVELOPE. Refusing
// cannot break delivery -- the message is sent before the echo is emitted -- but
// it does drop the echo, and on WhatsApp the echo is the only thing advancing the
// conversation, so strict mode converts a producer bug into a full stall of every
// WhatsApp survey. Publishing unstamped instead degrades to an unscoped replay,
// which still advances. Degraded-but-moving beats stopped.
//
// Turn it on in staging first, where a stalled survey is a test failure rather
// than a participant.
//
// The log line is deliberately identity-only: key, topic and which fields are
// missing. It never includes the body, which carries participant message
// content.
func (kp *KafkaProducer) guardEnvelope(key string, value []byte) error {
	missing := MissingEnvelopeFields(value)
	if missing == nil {
		return nil
	}

	kp.logger.Error(EnvelopeMissingTag,
		zap.String("topic", kp.topic),
		zap.String("key", key),
		zap.Strings("missing", missing),
		zap.Bool("strict", kp.strictEnvelope),
	)

	if kp.strictEnvelope {
		return fmt.Errorf("%s: refusing to publish to %s without %v", EnvelopeMissingTag, kp.topic, missing)
	}
	return nil
}

// Close closes the Kafka producer
func (kp *KafkaProducer) Close() {
	// Flush any pending messages
	kp.producer.Flush(15000) // 15 second timeout
	kp.producer.Close()
}

func joinStrings(strs []string, sep string) string {
	if len(strs) == 0 {
		return ""
	}
	result := strs[0]
	for i := 1; i < len(strs); i++ {
		result += sep + strs[i]
	}
	return result
}

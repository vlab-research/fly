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
	key := []byte(event.ConversationID)

	// Use the producer's configured topic (KAFKA_EVENT_TOPIC = "chat-events")
	topicName := kp.topic
	msg := &kafka.Message{
		TopicPartition: kafka.TopicPartition{
			Topic:     &topicName,
			Partition: kafka.PartitionAny,
		},
		Key:   key,
		Value: data,
	}

	// Async produce with delivery report
	deliveryChan := make(chan kafka.Event)
	err = kp.producer.Produce(msg, deliveryChan)
	if err != nil {
		return fmt.Errorf("failed to produce message: %w", err)
	}

	// Wait for delivery report
	select {
	case <-ctx.Done():
		return ctx.Err()
	case e := <-deliveryChan:
		m := e.(*kafka.Message)
		if m.TopicPartition.Error != nil {
			return fmt.Errorf("delivery failed: %w", m.TopicPartition.Error)
		}
		kp.logger.Debug("event delivered",
			zap.String("event_id", event.EventID),
			zap.String("event_type", event.EventType),
			zap.Int32("partition", m.TopicPartition.Partition),
			zap.Int64("offset", int64(m.TopicPartition.Offset)))
		return nil
	}
}

// PublishRawEvent sends pre-serialized event bytes to the configured topic
// under the given partition key (used for replybot-shaped events like the
// WhatsApp send echo, whose JSON differs from types.UniversalEvent).
func (kp *KafkaProducer) PublishRawEvent(ctx context.Context, key string, value []byte) error {
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
		return fmt.Errorf("failed to produce message: %w", err)
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	case e := <-deliveryChan:
		m := e.(*kafka.Message)
		if m.TopicPartition.Error != nil {
			return fmt.Errorf("delivery failed: %w", m.TopicPartition.Error)
		}
		return nil
	}
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

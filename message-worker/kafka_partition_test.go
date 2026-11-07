package messageworker

import (
	"context"
	"encoding/binary"
	"fmt"
	"testing"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"go.uber.org/zap"
)

// javaMurmur2 is Kafka's Utils.murmur2, independent of librdkafka.
func javaMurmur2(data []byte) int32 {
	const (
		seed uint32 = 0x9747b28c
		m    uint32 = 0x5bd1e995
		r           = 24
	)
	length := len(data)
	h := seed ^ uint32(length)
	n := length / 4
	for i := 0; i < n; i++ {
		k := binary.LittleEndian.Uint32(data[i*4:])
		k *= m
		k ^= k >> r
		k *= m
		h *= m
		h ^= k
	}
	tail := data[n*4:]
	switch length % 4 {
	case 3:
		h ^= uint32(tail[2]) << 16
		fallthrough
	case 2:
		h ^= uint32(tail[1]) << 8
		fallthrough
	case 1:
		h ^= uint32(tail[0])
		h *= m
	}
	h ^= h >> 13
	h *= m
	h ^= h >> 15
	return int32(h)
}

func javaPartition(key string, partitions int) int32 {
	return (javaMurmur2([]byte(key)) & 0x7fffffff) % int32(partitions)
}

func TestJavaMurmur2MatchesKafkaReference(t *testing.T) {
	// From Kafka's UtilsTest.testMurmur2.
	if got := javaMurmur2([]byte("21")); got != -973932308 {
		t.Fatalf("javaMurmur2(\"21\") = %d, want -973932308", got)
	}
}

func TestProducerConfigUsesHermesPartitioner(t *testing.T) {
	v, err := producerConfig([]string{"localhost:9092"}).Get("partitioner", nil)
	if err != nil {
		t.Fatal(err)
	}
	if v != "murmur2_random" {
		t.Fatalf("partitioner = %v, want murmur2_random (hermes/src/producer.rs)", v)
	}
}

func TestPublishLandsOnHermesPartition(t *testing.T) {
	const topic = "chat-events"
	const partitions = 48 // vlab-prod-chat-events

	mc, err := kafka.NewMockCluster(1)
	if err != nil {
		t.Fatal(err)
	}
	defer mc.Close()
	if err := mc.CreateTopic(topic, partitions, 1); err != nil {
		t.Fatal(err)
	}

	kp, err := NewKafkaProducer([]string{mc.BootstrapServers()}, topic, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	defer kp.Close()

	keys := []string{"393343583009", "254712345678", "212612345678", "40568915462707623"}
	for i := 0; i < 50; i++ {
		keys = append(keys, fmt.Sprintf("2547%08d", i*7919))
	}

	for _, key := range keys {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		m, err := kp.publish(ctx, key, []byte(`{"account_id":"a","platform":"whatsapp"}`))
		cancel()
		if err != nil {
			t.Fatalf("publish %q: %v", key, err)
		}
		if want := javaPartition(key, partitions); m.TopicPartition.Partition != want {
			t.Errorf("key %q: partition %d, hermes would use %d", key, m.TopicPartition.Partition, want)
		}
	}
}

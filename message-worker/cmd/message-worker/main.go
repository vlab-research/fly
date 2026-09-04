package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/vlab-research/burrow"
	messageworker "github.com/vlab-research/fly/message-worker"
	"github.com/vlab-research/fly/message-worker/types"
	"go.uber.org/zap"
)

func startHealthServer(port string, logger *zap.Logger) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	go func() {
		logger.Info("starting health server", zap.String("port", port))
		if err := http.ListenAndServe(":"+port, mux); err != nil {
			logger.Error("health server failed", zap.Error(err))
		}
	}()
}

func main() {
	logger, err := zap.NewProduction()
	if err != nil {
		os.Exit(1)
	}
	defer logger.Sync()

	logger.Info("starting message-worker")

	healthPort := os.Getenv("HEALTH_PORT")
	if healthPort == "" {
		healthPort = "8081"
	}
	startHealthServer(healthPort, logger)

	// Load configuration
	config, err := messageworker.LoadConfigFromEnv()
	if err != nil {
		logger.Fatal("failed to load configuration", zap.Error(err))
	}

	logger.Info("configuration loaded",
		zap.Strings("kafka_brokers", config.KafkaBrokers),
		zap.String("group_id", config.KafkaGroupID),
		zap.String("facebook_graph_url", config.FacebookGraphURL),
		zap.Int("num_workers", config.NumWorkers))

	// Create context for initialization
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Initialize TokenStore
	var tokenStore messageworker.TokenStore
	tokenStore, err = messageworker.NewPostgresTokenStore(ctx, config.DatabaseURL, config.TokenCacheTTL)
	if err != nil {
		logger.Fatal("failed to create token store", zap.Error(err))
	}
	defer tokenStore.Close()
	logger.Info("token store initialized", zap.Duration("cache_ttl", config.TokenCacheTTL))

	// Create Kafka consumer
	consumer, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers":  joinStrings(config.KafkaBrokers, ","),
		"group.id":           config.KafkaGroupID,
		"auto.offset.reset":  config.KafkaAutoOffsetReset,
		"enable.auto.commit": false, // Burrow handles commits

		// Explicit rather than inherited, so the eviction budget is a number
		// someone chose. This is librdkafka's own default; it is spelled out
		// because it is the clock that decides whether a slow send becomes a
		// rebalance. Burrow v0.1.6 pauses a saturated partition instead of
		// blocking the poll loop, so this should no longer be reachable --
		// which is exactly why a silent default would be the wrong thing to
		// rely on.
		"max.poll.interval.ms": 300000,
	})
	if err != nil {
		logger.Fatal("failed to create kafka consumer", zap.Error(err))
	}
	defer consumer.Close()

	// NOTE: the topic subscription happens through the burrow pool further
	// down, not here. Subscribing the consumer directly leaves burrow's
	// rebalance callback unattached, and it has no way to attach it after the
	// fact -- see the pool.Subscribe call below.

	// Create Kafka producer for events
	eventProducer, err := messageworker.NewKafkaProducer(
		config.KafkaBrokers,
		config.KafkaEventTopic,
		logger,
	)
	if err != nil {
		logger.Fatal("failed to create event producer", zap.Error(err))
	}
	// message-worker writes to chat-events directly, so the envelope guard is
	// this service's own responsibility -- nothing upstream stamps for it.
	eventProducer.WithStrictEnvelope(config.StrictEventEnvelope)
	defer eventProducer.Close()

	// Create platform clients map
	clients := make(map[types.PlatformType]messageworker.MessageSender)

	// Create Messenger client with proper Facebook Graph API integration
	messengerClient := messageworker.NewMessengerClient(config.FacebookGraphURL, tokenStore)
	clients[types.PlatformMessenger] = messengerClient
	logger.Info("registered Messenger client", zap.String("url", config.FacebookGraphURL))

	// Create WhatsApp client (real Cloud API HTTP client)
	whatsappClient := messageworker.NewWhatsAppClient(config.WhatsAppGraphURL, tokenStore)
	clients[types.PlatformWhatsApp] = whatsappClient
	logger.Info("registered WhatsApp client", zap.String("url", config.WhatsAppGraphURL))

	// Create stub clients for platforms not yet implemented
	clients[types.PlatformInstagram] = messageworker.NewInstagramClient()
	logger.Info("registered Instagram client (stub)")

	clients[types.PlatformTelegram] = messageworker.NewTelegramClient()
	logger.Info("registered Telegram client (stub)")

	logger.Info("platform clients initialized", zap.Int("platforms", len(clients)))

	// Create worker with business logic
	worker := messageworker.NewWorker(clients, eventProducer, config.BotserverURL, logger)
	logger.Info("worker initialized with botserver", zap.String("botserver_url", config.BotserverURL))

	// Media handle layer (planning/media-abstraction.md). A lookup failure here
	// must not stop the worker from starting -- the handle layer is an
	// optimisation, never a requirement, so a store that failed to initialize
	// degrades to URL-only sends the same way a nil store does.
	mediaStore, err := messageworker.NewPostgresMediaStore(ctx, config.DatabaseURL)
	if err != nil {
		logger.Warn("failed to create media store, media will send by URL only", zap.Error(err))
	} else {
		defer mediaStore.Close()
		worker = worker.WithMediaStore(mediaStore, config.MediaHandleUse, config.MediaHandleMargin)
	}
	logger.Info("media handle layer configured",
		zap.Bool("media_handle_use", config.MediaHandleUse),
		zap.Duration("media_handle_margin", config.MediaHandleMargin))

	// Create Burrow pool for concurrent processing.
	//
	// As of burrow v0.1.6 the pool runs one sub-pool PER ASSIGNED PARTITION,
	// so NumWorkers is per partition, not per pod. This pod's send concurrency
	// is NUM_WORKERS x partitions assigned to it, and the assignment moves with
	// the group -- a scale-down concentrates partitions and therefore raises
	// per-pod concurrency.
	//
	// NUM_WORKERS was deliberately NOT lowered to compensate. The retry ladder
	// parks a worker for the length of the ladder, so the extra concurrency is
	// the headroom that keeps one parked user from costing others their
	// throughput. It does not widen 131056 exposure: that is a per-recipient
	// pair limit, and key affinity already serializes any one user onto one
	// worker. See devops/values/production.yaml.
	burrowConfig := burrow.DefaultConfig(logger)
	burrowConfig.NumWorkers = config.NumWorkers
	burrowConfig.CommitInterval = 5 * time.Second
	burrowConfig.CommitBatchSize = 1000

	// REQUIRED whenever NumWorkers > 1. Commands are keyed by user_id
	// (replybot/lib/index.js), and a user's messages must reach the platform in
	// the order the state machine produced them — a question must not overtake
	// the statement that sets it up. Without this, burrow hands consecutive
	// messages to whichever worker is free and the pair can invert.
	//
	// Enabled unconditionally rather than only for NumWorkers > 1: it is a
	// no-op at 1 worker, and making it conditional would mean a later bump of
	// NUM_WORKERS silently reintroduces the reordering bug.
	burrowConfig.KeyAffinity = true

	pool, err := burrow.NewPool(consumer, burrowConfig)
	if err != nil {
		logger.Fatal("failed to create burrow pool", zap.Error(err))
	}

	// Subscribe THROUGH THE POOL. burrow's rebalance callback is private, so
	// consumer.SubscribeTopics(topic, nil) -- which is what this did until
	// v0.1.6 -- left it unattached: the pool never learned that partitions
	// changed hands, so it did not commit what it had finished before losing
	// one, and every rolling deploy replayed the uncommitted window as
	// duplicate sends to real people.
	if err := pool.Subscribe([]string{config.KafkaCommandTopic}); err != nil {
		logger.Fatal("failed to subscribe to topics", zap.Error(err))
	}
	logger.Info("subscribed to command topic", zap.String("topic", config.KafkaCommandTopic))

	// Setup graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-sigChan
		logger.Info("shutdown signal received", zap.String("signal", sig.String()))
		cancel()
	}()

	processFunc := func(ctx context.Context, msg *kafka.Message) error {
		var baseCmd struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(msg.Value, &baseCmd); err != nil {
			logger.Error("failed to unmarshal command — skipping",
				zap.Error(err),
				zap.ByteString("value", msg.Value))
			return nil
		}

		err := worker.ProcessCommand(ctx, msg.Value)

		// The send failed but was already reported to botserver, so the offset
		// still commits — log the failure rather than claiming success.
		var handledErr *messageworker.HandledError
		if errors.As(err, &handledErr) {
			logger.Warn("command send failed but handled/reported",
				zap.Error(handledErr.Unwrap()),
				zap.ByteString("value", msg.Value))
			return nil
		}

		if err != nil {
			logger.Error("failed to process command",
				zap.Error(err),
				zap.ByteString("value", msg.Value))
			return err
		}

		logger.Info("command processed successfully",
			zap.ByteString("value", msg.Value))

		return nil
	}

	// Run the pool (blocks until context cancelled)
	logger.Info("starting message processing", zap.Int("workers", config.NumWorkers))
	if err := pool.Run(ctx, processFunc); err != nil && err != context.Canceled {
		logger.Fatal("pool error", zap.Error(err))
	}

	logger.Info("message-worker stopped gracefully")
}

// Helper function for joining strings
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

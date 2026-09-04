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
		// someone chose. This is librdkafka's own default; it is the clock
		// that decides whether a slow send becomes a rebalance.
		"max.poll.interval.ms": 300000,
	})
	if err != nil {
		logger.Fatal("failed to create kafka consumer", zap.Error(err))
	}
	defer consumer.Close()

	// NOTE: the topic subscription happens through the burrow pool further
	// down, not here. See the pool.Subscribe call below.

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
	whatsappClient := messageworker.NewWhatsAppClient(config.WhatsAppGraphURL, tokenStore).
		WithRetryCodes(config.WhatsAppRetryCodes)
	clients[types.PlatformWhatsApp] = whatsappClient
	logger.Info("registered WhatsApp client",
		zap.String("url", config.WhatsAppGraphURL),
		zap.Ints("retry_codes", config.WhatsAppRetryCodes))

	// Create stub clients for platforms not yet implemented
	clients[types.PlatformInstagram] = messageworker.NewInstagramClient()
	logger.Info("registered Instagram client (stub)")

	clients[types.PlatformTelegram] = messageworker.NewTelegramClient()
	logger.Info("registered Telegram client (stub)")

	logger.Info("platform clients initialized", zap.Int("platforms", len(clients)))

	// Create worker with business logic
	// Retry behaviour comes from configuration. Until now Config read
	// MAX_RETRY_ATTEMPTS, INITIAL_BACKOFF_MS and MAX_BACKOFF_MS and then
	// dropped them: NewWorker took DefaultRetryConfig unconditionally, so
	// setting those variables did nothing.
	retryConfig := messageworker.RetryConfig{
		MaxAttempts:    config.MaxRetryAttempts,
		InitialBackoff: time.Duration(config.InitialBackoffMS) * time.Millisecond,
		MaxBackoff:     time.Duration(config.MaxBackoffMS) * time.Millisecond,
		MaxElapsed:     config.MaxRetryElapsed,
	}

	worker := messageworker.NewWorker(clients, eventProducer, config.BotserverURL, logger).
		WithRetryConfig(retryConfig)
	logger.Info("worker initialized with botserver",
		zap.String("botserver_url", config.BotserverURL),
		zap.Int("retry_max_attempts", retryConfig.MaxAttempts),
		zap.Duration("retry_initial_backoff", retryConfig.InitialBackoff),
		zap.Duration("retry_max_backoff", retryConfig.MaxBackoff),
		zap.Duration("retry_max_elapsed", retryConfig.MaxElapsed))

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
	// Ordering is inherent as of burrow v0.2.0. Commands are keyed by user_id
	// (replybot/lib/index.js), and burrow processes a key on at most one worker
	// at a time -- so a user's messages reach the platform in the order the
	// state machine produced them, and a question cannot overtake the statement
	// that sets it up. There is no flag to forget to set.
	//
	// NUM_WORKERS is pool-wide and is pure concurrency: workers are bound to
	// nothing, so its value cannot change which worker sees which key.
	burrowConfig := burrow.DefaultConfig(logger)
	burrowConfig.NumWorkers = config.NumWorkers
	burrowConfig.CommitInterval = 5 * time.Second
	burrowConfig.CommitBatchSize = 1000

	// Buffered work is uncommitted, and redelivery here means re-sending to
	// real people, so keep the bound small. 10 x NUM_WORKERS jobs may wait;
	// beyond that the poll loop waits, which means every worker is busy and
	// the buffer behind them is full.
	burrowConfig.QueueSizePerWorker = 10

	pool, err := burrow.NewPool(consumer, burrowConfig)
	if err != nil {
		logger.Fatal("failed to create burrow pool", zap.Error(err))
	}

	// Subscribe THROUGH THE POOL. burrow's rebalance callback is private and
	// cannot be supplied from outside, so consumer.SubscribeTopics(topic, nil)
	// leaves the pool blind to rebalances: it would not commit what it had
	// finished before losing a partition, and every rolling deploy would
	// replay the uncommitted window as duplicate sends to real people.
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

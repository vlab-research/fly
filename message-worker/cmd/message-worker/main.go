package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	messageworker "github.com/vlab-research/fly/message-worker"
	"github.com/vlab-research/fly/message-worker/types"
	"github.com/vlab-research/burrow"
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
	})
	if err != nil {
		logger.Fatal("failed to create kafka consumer", zap.Error(err))
	}
	defer consumer.Close()

	// Subscribe to command topic
	err = consumer.SubscribeTopics([]string{config.KafkaCommandTopic}, nil)
	if err != nil {
		logger.Fatal("failed to subscribe to topics", zap.Error(err))
	}

	// Create Kafka producer for events
	eventProducer, err := messageworker.NewKafkaProducer(
		config.KafkaBrokers,
		config.KafkaEventTopic,
		logger,
	)
	if err != nil {
		logger.Fatal("failed to create event producer", zap.Error(err))
	}
	defer eventProducer.Close()

	// Create platform clients map
	clients := make(map[types.PlatformType]messageworker.MessageSender)

	// Create Messenger client with proper Facebook Graph API integration
	messengerClient := messageworker.NewMessengerClient(config.FacebookGraphURL, tokenStore)
	clients[types.PlatformMessenger] = messengerClient
	logger.Info("registered Messenger client", zap.String("url", config.FacebookGraphURL))

	// Create stub clients for platforms not yet implemented
	clients[types.PlatformWhatsApp] = messageworker.NewWhatsAppClient()
	logger.Info("registered WhatsApp client (stub)")

	clients[types.PlatformInstagram] = messageworker.NewInstagramClient()
	logger.Info("registered Instagram client (stub)")

	clients[types.PlatformTelegram] = messageworker.NewTelegramClient()
	logger.Info("registered Telegram client (stub)")

	logger.Info("platform clients initialized", zap.Int("platforms", len(clients)))

	// Create worker with business logic
	worker := messageworker.NewWorker(clients, eventProducer, config.BotserverURL, logger)
	logger.Info("worker initialized with botserver", zap.String("botserver_url", config.BotserverURL))

	// Create Burrow pool for concurrent processing
	burrowConfig := burrow.DefaultConfig(logger)
	burrowConfig.NumWorkers = config.NumWorkers
	burrowConfig.CommitInterval = 5 * time.Second
	burrowConfig.CommitBatchSize = 1000

	pool, err := burrow.NewPool(consumer, burrowConfig)
	if err != nil {
		logger.Fatal("failed to create burrow pool", zap.Error(err))
	}

	// Setup graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-sigChan
		logger.Info("shutdown signal received", zap.String("signal", sig.String()))
		cancel()
	}()

	// Define process function that integrates with Worker
	processFunc := func(ctx context.Context, msg *kafka.Message) error {
		var cmd types.SendMessageCommand
		if err := json.Unmarshal(msg.Value, &cmd); err != nil {
			logger.Error("failed to unmarshal command — skipping",
				zap.Error(err),
				zap.ByteString("value", msg.Value))
			return nil
		}

		if err := worker.ProcessCommand(ctx, cmd); err != nil {
			logger.Error("failed to process command",
				zap.String("command_id", cmd.CommandID),
				zap.String("platform", string(cmd.Platform)),
				zap.String("platform_account_id", cmd.PlatformAccountID),
				zap.String("user_id", cmd.UserID),
				zap.Error(err))
			return err
		}

		logger.Info("command processed successfully",
			zap.String("command_id", cmd.CommandID),
			zap.String("platform", string(cmd.Platform)),
			zap.String("user_id", cmd.UserID))

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

package messageworker

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all configuration for the message worker
type Config struct {
	// Kafka
	KafkaBrokers         []string
	KafkaGroupID         string
	KafkaCommandTopic    string
	KafkaEventTopic      string
	KafkaAutoOffsetReset string

	// Worker
	NumWorkers int

	// Database for token lookup
	DatabaseURL   string
	TokenCacheTTL time.Duration

	// Platform API base URLs
	FacebookGraphURL string // For Messenger/Instagram (e.g., "https://graph.facebook.com/v18.0" or "http://gbv-facebot")
	WhatsAppGraphURL string // WhatsApp Cloud API base (e.g., "https://graph.facebook.com/v18.0" or a mock)

	// Legacy config (kept for backwards compatibility but not used)
	MessengerURL    string
	MessengerAPIKey string
	WhatsAppURL     string
	WhatsAppAPIKey  string
	InstagramURL    string
	InstagramAPIKey string

	// Retry
	MaxRetryAttempts int
	InitialBackoffMS int
	MaxBackoffMS     int

	// Error reporting
	BotserverURL string // For reporting errors to botserver /synthetic endpoint

	// Media handle layer (planning/media-abstraction.md). Off by default --
	// this ships dark; see §8.5 for the staged rollout.
	MediaHandleUse    bool
	MediaHandleMargin time.Duration
}

// LoadConfigFromEnv loads configuration from environment variables
func LoadConfigFromEnv() (*Config, error) {
	config := &Config{
		// Kafka defaults
		KafkaBrokers:         parseCommaSeparated(getEnvOrDefault("KAFKA_BROKERS", "localhost:9092")),
		KafkaGroupID:         os.Getenv("KAFKA_GROUP_ID"), // REQUIRED, no default — see validation below
		KafkaCommandTopic:    getEnvOrDefault("KAFKA_COMMAND_TOPIC", "commands"),
		KafkaEventTopic:      getEnvOrDefault("KAFKA_EVENT_TOPIC", "chat-events"),
		KafkaAutoOffsetReset: getEnvOrDefault("KAFKA_AUTO_OFFSET_RESET", "earliest"),

		// Worker defaults
		NumWorkers: getEnvAsInt("NUM_WORKERS", 100),

		// Database for token lookup
		DatabaseURL:   os.Getenv("DATABASE_URL"),
		TokenCacheTTL: time.Duration(getEnvAsInt("TOKEN_CACHE_TTL", 300)) * time.Second,

		// Facebook Graph API URL (for Messenger/Instagram)
		FacebookGraphURL: getEnvOrDefault("FACEBOOK_GRAPH_URL", "https://graph.facebook.com/v18.0"),
		// WhatsApp Cloud API URL (defaults to the Graph API; overridden to a mock in tests)
		WhatsAppGraphURL: getEnvOrDefault("WHATSAPP_GRAPH_URL", "https://graph.facebook.com/v18.0"),

		// Legacy config (kept for backwards compatibility)
		MessengerURL:    os.Getenv("MESSENGER_URL"),
		MessengerAPIKey: os.Getenv("MESSENGER_API_KEY"),
		WhatsAppURL:     os.Getenv("WHATSAPP_URL"),
		WhatsAppAPIKey:  os.Getenv("WHATSAPP_API_KEY"),
		InstagramURL:    os.Getenv("INSTAGRAM_URL"),
		InstagramAPIKey: os.Getenv("INSTAGRAM_API_KEY"),

		// Retry defaults
		MaxRetryAttempts: getEnvAsInt("MAX_RETRY_ATTEMPTS", 3),
		InitialBackoffMS: getEnvAsInt("INITIAL_BACKOFF_MS", 100),
		MaxBackoffMS:     getEnvAsInt("MAX_BACKOFF_MS", 1000),

		// Error reporting
		BotserverURL: os.Getenv("BOTSERVER_URL"),

		// Media handle layer -- DEFAULT OFF, ships dark.
		MediaHandleUse:    getEnvAsBool("MEDIA_HANDLE_USE", false),
		MediaHandleMargin: getEnvAsDuration("MEDIA_HANDLE_MARGIN", time.Hour),
	}

	// Validate required config
	if config.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required for token lookup")
	}

	if config.BotserverURL == "" {
		return nil, fmt.Errorf("BOTSERVER_URL is required for error reporting")
	}

	// KAFKA_GROUP_ID has no default on purpose. One Kafka cluster is shared by
	// production and staging, so the consumer group MUST be env-scoped
	// (vlab-prod-message-worker / vlab-staging-message-worker) to match the
	// vlab-<env>-* topic convention. Consumer-group alerting in
	// devops/kafka-consumer-health/values.yaml is keyed on the exact group name,
	// so a bare fallback like "message-worker" would let a deploy that forgot
	// this variable start up healthy-looking while joining a group that NOTHING
	// alerts on — and message-worker is the sole outbound send path. Failing
	// loudly at startup is strictly safer than a plausible-looking default.
	if config.KafkaGroupID == "" {
		return nil, fmt.Errorf(
			"KAFKA_GROUP_ID is required and must be env-scoped, e.g. " +
				"vlab-prod-message-worker or vlab-staging-message-worker; " +
				"it must also have a matching row in " +
				"devops/kafka-consumer-health/values.yaml or the group will run unmonitored")
	}

	return config, nil
}

func getEnvOrDefault(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvAsInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if intValue, err := strconv.Atoi(value); err == nil {
			return intValue
		}
	}
	return defaultValue
}

func getEnvAsBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		if boolValue, err := strconv.ParseBool(value); err == nil {
			return boolValue
		}
	}
	return defaultValue
}

func getEnvAsDuration(key string, defaultValue time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		if durValue, err := time.ParseDuration(value); err == nil {
			return durValue
		}
	}
	return defaultValue
}

func parseCommaSeparated(s string) []string {
	parts := strings.Split(s, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

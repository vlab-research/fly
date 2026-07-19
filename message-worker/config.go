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
}

// LoadConfigFromEnv loads configuration from environment variables
func LoadConfigFromEnv() (*Config, error) {
	config := &Config{
		// Kafka defaults
		KafkaBrokers:         parseCommaSeparated(getEnvOrDefault("KAFKA_BROKERS", "localhost:9092")),
		KafkaGroupID:         getEnvOrDefault("KAFKA_GROUP_ID", "message-worker"),
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
	}

	// Validate required config
	if config.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required for token lookup")
	}

	if config.BotserverURL == "" {
		return nil, fmt.Errorf("BOTSERVER_URL is required for error reporting")
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

package main

import (
	"time"

	"github.com/caarlos0/env/v6"
)

type Config struct {
	CacheTTL            time.Duration `env:"CACHE_TTL,required"`
	CacheNumCounters    int64         `env:"CACHE_NUM_COUNTERS,required"`
	CacheMaxCost        int64         `env:"CACHE_MAX_COST,required"`
	CacheBufferItems    int64         `env:"CACHE_BUFFER_ITEMS,required"`
	Sandbox             bool          `env:"RELOADLY_SANDBOX,required"`
	Botserver           string        `env:"BOTSERVER_URL,required"`
	DbName              string        `env:"CHATBASE_DATABASE,required"`
	DbHost              string        `env:"CHATBASE_HOST,required"`
	DbPort              int           `env:"CHATBASE_PORT,required"`
	DbUser              string        `env:"CHATBASE_USER,required"`
	DbMaxConns          int           `env:"CHATBASE_MAX_CONNECTIONS,required"`
	KafkaBrokers        string        `env:"KAFKA_BROKERS,required"`
	KafkaPollTimeout    time.Duration `env:"KAFKA_POLL_TIMEOUT,required"`
	KafkaTopic          string        `env:"KAFKA_TOPIC,required"`
	KafkaGroup          string        `env:"KAFKA_GROUP,required"`
	KafkaBatchSize      int           `env:"DINERSCLUB_BATCH_SIZE,required"`
	RetryBotserver      time.Duration `env:"DINERSCLUB_RETRY_BOTSERVER,required"`
	RetryProvider       time.Duration `env:"DINERSCLUB_RETRY_PROVIDER,required"`
	PoolSize            int           `env:"DINERSCLUB_POOL_SIZE,required"`
	Providers           []string      `env:"DINERSCLUB_PROVIDERS" envSeparator:","`
	BackOffRandomFactor float64       `env:"BACK_OFF_RANDOM_FACTOR" envDefault:"0.5"`

	// Hard timeout on a single outbound provider HTTP call. NOT the same as
	// RetryProvider, which bounds elapsed time *across* backoff attempts and
	// therefore cannot bound an attempt that never returns. Defaulted rather
	// than required so an unset environment still gets a bound -- an unbounded
	// provider call wedges the whole consumer (see README, "Why provider calls
	// have a hard timeout").
	ProviderTimeout time.Duration `env:"DINERSCLUB_PROVIDER_TIMEOUT" envDefault:"30s"`

	// Port for the /metrics endpoint. Defaulted rather than required because
	// the test binary and local runs should not have to know about it, and a
	// service that refuses to start over a metrics port would be a worse
	// trade than one that cannot be scraped.
	MetricsPort int `env:"DINERSCLUB_METRICS_PORT" envDefault:"9090"`
}

func getConfig() *Config {
	cfg := Config{}
	err := env.Parse(&cfg)
	handle(err)
	return &cfg
}

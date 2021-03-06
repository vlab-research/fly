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
}

func getConfig() *Config {
	cfg := Config{}
	err := env.Parse(&cfg)
	handle(err)
	return &cfg
}

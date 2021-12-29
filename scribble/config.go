package main

import (
	"time"
	"log"

	"github.com/caarlos0/env/v6"
)

type Config struct {
	DbName           string        `env:"CHATBASE_DATABASE,required"`
	DbUser           string        `env:"CHATBASE_USER,required"`
	DbHost           string        `env:"CHATBASE_HOST,required"`
	DbPort           int           `env:"CHATBASE_PORT,required"`
	DbMaxConns       int           `env:"CHATBASE_MAX_CONNECTIONS,required"`
	KafkaBrokers     string        `env:"KAFKA_BROKERS,required"`
	KafkaPollTimeout time.Duration `env:"KAFKA_POLL_TIMEOUT,required"`
	Topic            string        `env:"KAFKA_TOPIC,required"`
	Group            string        `env:"KAFKA_GROUP,required"`
	BatchSize        int           `env:"SCRIBBLE_BATCH_SIZE,required"`
	ChunkSize        int           `env:"SCRIBBLE_CHUNK_SIZE,required"`
	Destination      string        `env:"SCRIBBLE_DESTINATION,required"`
	Handlers         string        `env:"SCRIBBLE_ERROR_HANDLERS,required"`
}

func getConfig() *Config {
	cfg := Config{}
	err := env.Parse(&cfg)
	handle(err)
	if cfg.Handlers != "" && cfg.ChunkSize != 1 {
		log.Fatalf("Scribble can only pass on errors with a chunk size of 1. Passed chunk size: %v",
			cfg.ChunkSize)
	}
	return &cfg
}

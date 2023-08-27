package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/caarlos0/env/v6"
	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/vlab-research/spine"
)

type Config struct {
	Db               string        `env:"CHATBASE_DATABASE,required"`
	User             string        `env:"CHATBASE_USER,required"`
	Password         string        `env:"CHATBASE_PASSWORD,required"`
	Host             string        `env:"CHATBASE_HOST,required"`
	Port             string        `env:"CHATBASE_PORT,required"`
	KafkaBrokers     string        `env:"KAFKA_BROKERS,required"`
	KafkaPollTimeout time.Duration `env:"KAFKA_POLL_TIMEOUT,required"`
	Topic            string        `env:"KAFKA_TOPIC,required"`
	Group            string        `env:"KAFKA_GROUP,required"`
	BatchSize        int           `env:"SCRIBBLE_BATCH_SIZE,required"`
	ChunkSize        int           `env:"SCRIBBLE_CHUNK_SIZE,required"`
	Destination      string        `env:"SCRIBBLE_DESTINATION,required"`
	Handlers         string        `env:"SCRIBBLE_ERROR_HANDLERS,required"`
}

func monitor(errs <-chan error) {
	e := <-errs
	log.Fatalf("Scribble failed with error: %v", e)
}

func checkError(err error) {
	// TODO: add acceptable errors?
	log.Fatalf("Scribble failed with error: %v", err)
}

func handle(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

func getPool(cfg *Config) *pgxpool.Pool {
	conString := fmt.Sprintf("postgresql://%s@%s:%s/%s?sslmode=disable", cfg.User, cfg.Host, cfg.Port, cfg.Db)
	config, err := pgxpool.ParseConfig(conString)
	handle(err)

	config.MaxConns = int32(32)

	ctx := context.Background()
	pool, err := pgxpool.ConnectConfig(ctx, config)
	handle(err)

	return pool
}

func getMarshaller(cfg *Config, pool *pgxpool.Pool) Scribbler {
	name := cfg.Destination

	marshallers := map[string]func(*pgxpool.Pool) Scribbler{
		"states":    NewStateScribbler,
		"responses": NewResponseScribbler,
		"messages":  NewMessageScribbler,
	}

	fn, ok := marshallers[name]
	if !ok {
		log.Fatalf("Scribble couldnt find a marshaller for destination %v", name)
	}
	return fn(pool)
}

func getConfig() Config {
	cfg := Config{}
	err := env.Parse(&cfg)
	handle(err)
	if cfg.Handlers != "" && cfg.ChunkSize != 1 {
		log.Fatalf("Scribble can only pass on errors with a chunk size of 1. Passed chunk size: %v",
			cfg.ChunkSize)
	}
	return cfg
}

func main() {
	cfg := getConfig()

	pool := getPool(&cfg)

	c := spine.NewKafkaConsumer(cfg.Topic, cfg.KafkaBrokers, cfg.Group,
		cfg.KafkaPollTimeout, cfg.BatchSize, cfg.ChunkSize)

	// monitor errors, with handling as per config
	errs := make(chan error)
	go monitor(HandleErrors(errs, getHandlers(&cfg)))

	// Write forever
	// getwriter takes the struct, not marshalwriteable
	writer := GetWriter(getMarshaller(&cfg, pool))
	for {
		c.SideEffect(writer.Write, checkError, errs)
	}
}

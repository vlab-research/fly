package main

import (
	"context"
	"fmt"
	"log"

	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/vlab-research/spine"
)

func monitor(errs <-chan error) {
	e := <-errs
	log.Fatalf("Scribble failed with error: %v", e)
}

func handle(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

func getPool(cfg *Config) *pgxpool.Pool {
	con := fmt.Sprintf("postgresql://%s@%s:%d/%s?sslmode=disable", cfg.DbUser, cfg.DbHost, cfg.DbPort, cfg.DbName)
	config, err := pgxpool.ParseConfig(con)
	handle(err)

	config.MaxConns = int32(cfg.DbMaxConns)

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

func main() {
	cfg := getConfig()
	pool := getPool(cfg)

	c := spine.NewKafkaConsumer(cfg.Topic, cfg.KafkaBrokers, cfg.Group,
		cfg.KafkaPollTimeout, cfg.BatchSize, cfg.ChunkSize)

	// monitor errors, with handling as per config
	errs := make(chan error)
	go monitor(HandleErrors(errs, getHandlers(cfg)))

	// Write forever
	// getwriter takes the struct, not marshalwriteable
	writer := GetWriter(getMarshaller(cfg, pool))
	for {
		c.SideEffect(writer.Write, errs)
	}
}

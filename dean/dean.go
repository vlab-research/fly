package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v4/pgxpool"
)

func merge(cs ...<-chan *ExternalEvent) <-chan *ExternalEvent {
	var wg sync.WaitGroup
	out := make(chan *ExternalEvent)
	output := func(c <-chan *ExternalEvent) {
		for n := range c {
			out <- n
		}
		wg.Done()
	}
	wg.Add(len(cs))
	for _, c := range cs {
		go output(c)
	}
	go func() {
		wg.Wait()
		close(out)
	}()
	return out
}

func handle(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

func send(cfg *Config, client *http.Client, e *ExternalEvent) error {

	body, err := json.Marshal(e)
	if err != nil {
		return err
	}

	resp, err := client.Post(cfg.Botserver, "application/json", bytes.NewBuffer(body))
	if err != nil {
		return err
	}

	code := resp.StatusCode
	if code != 200 {
		err := fmt.Errorf("Non 200 response from Botserver: %v", code)
		log.Print(err)
		return err
	}

	return nil
}

func process(cfg *Config, ch <-chan *ExternalEvent) {
	client := &http.Client{}

	counter := 0
	for e := range ch {
		err := send(cfg, client, e)
		handle(err)
		counter += 1
		time.Sleep(cfg.SendDelay)
	}
	log.Printf("Dean successfully sent %v new events", counter)
}

func getConn(cfg *Config) *pgxpool.Pool {
	con := fmt.Sprintf("postgresql://%s@%s:%d/%s?sslmode=disable", cfg.DbUser, cfg.DbHost, cfg.DbPort, cfg.DbName)
	config, err := pgxpool.ParseConfig(con)
	handle(err)

	ctx := context.Background()
	pool, err := pgxpool.ConnectConfig(ctx, config)
	handle(err)

	return pool
}

func getQueries(cfg *Config, pool *pgxpool.Pool) []<-chan *ExternalEvent {
	lookup := map[string]Query{
		"respondings": Respondings,
		"blocked":     Blocked,
		"errored":     Errored,
		"timeouts":    Timeouts,
		"followups":   FollowUps,
	}
	queries := strings.Split(cfg.Queries, ",")
	chans := []<-chan *ExternalEvent{}
	for _, q := range queries {
		chans = append(chans, lookup[q](cfg, pool))
	}
	return chans
}

func main() {
	cfg := getConfig()
	pool := getConn(cfg)
	defer pool.Close()

	ch := merge(getQueries(cfg, pool)...)
	process(cfg, ch)
}

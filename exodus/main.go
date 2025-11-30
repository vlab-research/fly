package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/vlab-research/exodus/api"
	"github.com/vlab-research/exodus/config"
	"github.com/vlab-research/exodus/db"
	"github.com/vlab-research/exodus/executor"
	"github.com/vlab-research/exodus/sender"
)

func main() {
	mode := flag.String("mode", "executor", "Mode: api or executor")
	flag.Parse()

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	if err := cfg.Validate(*mode); err != nil {
		log.Fatalf("Invalid config for mode %s: %v", *mode, err)
	}

	database, err := db.New(cfg.ConnectionString())
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer database.Close()

	switch *mode {
	case "api":
		runAPI(cfg, database)
	case "executor":
		runExecutor(cfg, database)
	default:
		log.Fatalf("Invalid mode: %s (must be 'api' or 'executor')", *mode)
	}
}

func runAPI(cfg *config.Config, database *db.DB) {
	server := api.New(database)

	// Graceful shutdown
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		addr := fmt.Sprintf(":%d", cfg.Port)
		log.Printf("Starting exodus API server on %s", addr)
		if err := server.Run(addr); err != nil {
			log.Printf("Server error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("Shutting down gracefully...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Fatalf("Shutdown error: %v", err)
	}

	log.Println("Server stopped")
}

func runExecutor(cfg *config.Config, database *db.DB) {
	snd := sender.New(cfg.BotserverURL, cfg.RateLimit, cfg.DryRun)
	// db.DB implements both BailStore and QueryExecutor interfaces
	exec := executor.New(database, database, snd, cfg.MaxBailUsers)

	ctx := context.Background()

	log.Println("Starting exodus executor...")
	if cfg.DryRun {
		log.Println("DRY RUN MODE - no bailouts will be sent")
	}

	if err := exec.Run(ctx); err != nil {
		log.Fatalf("Executor failed: %v", err)
	}

	log.Println("Executor completed successfully")
}

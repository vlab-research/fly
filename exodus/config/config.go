package config

import (
	"fmt"
	"time"

	"github.com/caarlos0/env/v6"
)

// Config holds all configuration for the exodus service
type Config struct {
	// Database
	DbName     string `env:"CHATBASE_DATABASE" envDefault:"chatroach"`
	DbHost     string `env:"CHATBASE_HOST" envDefault:"localhost"`
	DbPort     int    `env:"CHATBASE_PORT" envDefault:"5433"`
	DbUser     string `env:"CHATBASE_USER" envDefault:"root"`
	DbPassword string `env:"CHATBASE_PASSWORD" envDefault:""`

	// Botserver
	BotserverURL string `env:"BOTSERVER_URL" envDefault:"http://localhost:8080/synthetic"`

	// Executor settings
	RateLimit    time.Duration `env:"EXODUS_RATE_LIMIT" envDefault:"1s"`
	MaxBailUsers int           `env:"EXODUS_MAX_BAIL_USERS" envDefault:"100000"`

	// API settings
	Port int `env:"PORT" envDefault:"8080"`

	// Operational
	DryRun bool `env:"DRY_RUN" envDefault:"false"`
}

// Load parses configuration from environment variables
func Load() (*Config, error) {
	cfg := &Config{}
	if err := env.Parse(cfg); err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}
	return cfg, nil
}

// ConnectionString returns the database connection string
func (c *Config) ConnectionString() string {
	if c.DbPassword != "" {
		return fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=disable",
			c.DbUser, c.DbPassword, c.DbHost, c.DbPort, c.DbName)
	}
	return fmt.Sprintf("postgres://%s@%s:%d/%s?sslmode=disable",
		c.DbUser, c.DbHost, c.DbPort, c.DbName)
}

// Validate checks if the configuration is valid for the given mode
func (c *Config) Validate(mode string) error {
	if mode == "executor" && c.BotserverURL == "" {
		return fmt.Errorf("BOTSERVER_URL is required in executor mode")
	}
	if mode == "api" && c.Port == 0 {
		return fmt.Errorf("PORT is required in API mode")
	}
	return nil
}

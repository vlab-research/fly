package main

import (
	"time"

	"github.com/caarlos0/env/v6"
)

type Config struct {
	DbName             string        `env:"CHATBASE_DATABASE,required"`
	DbHost             string        `env:"CHATBASE_HOST,required"`
	DbPort             int           `env:"CHATBASE_PORT,required"`
	DbUser             string        `env:"CHATBASE_USER,required"`
	Botserver          string        `env:"BOTSERVER_URL,required"`
	Codes              []string      `env:"DEAN_FB_CODES,required" envSeparator:","`
	ErrorTags          []string      `env:"DEAN_ERROR_TAGS,required" envSeparator:","`
	ErrorInterval      string        `env:"DEAN_ERROR_INTERVAL,required"`
	BlockedInterval    string        `env:"DEAN_BLOCKED_INTERVAL,required"`
	RespondingInterval string        `env:"DEAN_RESPONDING_INTERVAL,required"`
	RespondingGrace    string        `env:"DEAN_RESPONDING_GRACE,required"`
	Queries            string        `env:"DEAN_QUERIES,required"`
	SendDelay          time.Duration `env:"DEAN_SEND_DELAY,required"`
	FollowUpMin        string        `env:"DEAN_FOLLOWUP_MIN,required"`
	FollowUpMax        string        `env:"DEAN_FOLLOWUP_MAX,required"`
}

func getConfig() *Config {
	cfg := Config{}
	err := env.Parse(&cfg)
	handle(err)
	return &cfg
}

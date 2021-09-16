package main

import (
	"github.com/caarlos0/env/v6"
)

type Config struct {
	DbName string `env:"CHATBASE_DATABASE,required"`
	DbUser string `env:"CHATBASE_USER,required"`
	DbHost string `env:"CHATBASE_HOST,required"`
	DbPort string `env:"CHATBASE_PORT,required"`
	Port   int    `default:"80"`
}

func getConfig() Config {
	cfg := Config{}
	err := env.Parse(&cfg)
	handle(err)
	return cfg
}

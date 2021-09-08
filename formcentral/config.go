package main

import (
	"github.com/caarlos0/env/v6"
)

type Config struct {
	Db       string `env:"CHATBASE_DATABASE,required"`
	User     string `env:"CHATBASE_USER,required"`
	Host     string `env:"CHATBASE_HOST,required"`
	Port     string `env:"CHATBASE_PORT,required"`
}

func getConfig() Config {
	config := Config{}
	err := env.Parse(&config)
	handle(err)
	return config
}

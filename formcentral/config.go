package main

import (
	"os"
)

var (
	PostgresDb       = os.Getenv("POSTGRES_DB")
	PostgresHost     = os.Getenv("POSTGRES_HOST")
	PostgresPort     = os.Getenv("POSTGRES_PORT")
	PostgresUser     = os.Getenv("POSTGRES_USER")
	PostgresPassword = os.Getenv("POSTGRES_PASSWORD")
)

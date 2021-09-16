package main

import (
	"fmt"
	"log"
	"net/http"
	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/labstack/echo/v4"
)

type Server struct {
	config Config
	pool   *pgxpool.Pool
}

func (s *Server) ResetDb(c echo.Context) error {
	resetDb(s.pool, s.config.SqlFilepath)
	return c.String(http.StatusOK, "ok")
}

func handle(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

func main() {
	cfg := getConfig()
	pool := getPool(&cfg)
	server := &Server{cfg, pool}

	e := echo.New()
	e.GET("/resetdb", server.ResetDb)

	address := fmt.Sprintf(`:%d`, cfg.Port)
	e.Logger.Fatal(e.Start(address))
}

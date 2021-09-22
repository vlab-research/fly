package main

import (
	"fmt"
	"log"
	"net/http"
	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/labstack/echo/v4"
)

type Server struct {
	pool       *pgxpool.Pool
	tablenames []string
}

func (s *Server) ResetDb(c echo.Context) error {
	resetDb(s.pool, s.tablenames)
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
	tablenames, err := getTableNames(pool)
	handle(err)
	server := &Server{pool, tablenames}

	e := echo.New()
	e.GET("/resetdb", server.ResetDb)

	address := fmt.Sprintf(`:%d`, cfg.Port)
	e.Logger.Fatal(e.Start(address))
}

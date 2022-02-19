package main

import (
	"fmt"
	"log"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/labstack/echo/v4"
	"github.com/vlab-research/trans"
)

type Server struct {
	pool *pgxpool.Pool
}

func (s *Server) Health(c echo.Context) error {
	return c.String(http.StatusOK, "pong")
}

func (s *Server) GetTranslator(c echo.Context) error {
	surveyid := c.Param("surveyid")

	src, dest, err := getTranslationForms(s.pool, surveyid)
	if err != nil {
		msg := fmt.Sprintf("Could not get translation form for survey: %v. Error: %v", surveyid, err.Error())
		return echo.NewHTTPError(http.StatusNotFound, msg)
	}

	translator, err := trans.MakeTranslatorByShape(src, dest)
	if err != nil {
		msg := err.Error()
		return echo.NewHTTPError(http.StatusInternalServerError, fmt.Sprintf("Could not create translation mapping. Failed with the following error: %v", msg))
	}

	return c.JSON(http.StatusOK, translator)
}

func (s *Server) CreateTranslator(c echo.Context) error {
	type TranslatorRequest struct {
		Form        *trans.FormJson `json:"form"`
		Destination string          `json:"destination"`
		Self        bool            `json:"self"`
	}
	req := new(TranslatorRequest)
	if err := c.Bind(req); err != nil {
		return err
	}

	var dest *trans.FormJson
	if req.Self {
		dest = req.Form
	} else {
		var err error
		dest, err = getForm(s.pool, req.Destination)
		if err != nil {
			msg := fmt.Sprintf("Could not find destination form: %v", req.Destination)
			return echo.NewHTTPError(http.StatusNotFound, msg)
		}
	}

	translator, err := trans.MakeTranslatorByShape(req.Form, dest)
	if err != nil {
		msg := fmt.Sprintf("Could not create translation mapping. Failed with the following error: %v", err.Error())
		return echo.NewHTTPError(http.StatusBadRequest, msg)
	}

	return c.JSON(http.StatusOK, translator)
}

func (s *Server) GetSurveyByParams(c echo.Context) error {
	pageid := c.QueryParam("pageid")
	shortcode := c.QueryParam("shortcode")
	timestamp := c.QueryParam("timestamp")

	if pageid == "" || shortcode == "" || timestamp == "" {
		return echo.NewHTTPError(http.StatusBadRequest, fmt.Sprintf("Missing Parameter(s)"))
	}

	timestampFloat, err := strconv.ParseFloat(timestamp, 0)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, fmt.Sprintf("Could not parse 'timestamp': %s", timestamp))
	}

	timestampFmt := time.Unix(int64(math.Ceil(timestampFloat/1000)), 0)
	survey, err := getSurveyByParams(s.pool, pageid, shortcode, timestampFmt)

	if err != nil {
		msg := err.Error()
		return echo.NewHTTPError(http.StatusInternalServerError, fmt.Sprintf("Could not execute query to DB. Failed with the following error: %v", msg))
	}

	if survey == nil {
		return echo.NewHTTPError(http.StatusNotFound, "Survey not found")
	}

	return c.JSON(http.StatusOK, survey)
}

func (s *Server) GetMetadata(c echo.Context) error {
	surveyid := c.QueryParam("surveyid")
	m, err := getSurveyMetadata(s.pool, surveyid)

	if err != nil {
		msg := err.Error()
		return echo.NewHTTPError(http.StatusInternalServerError, fmt.Sprintf("Could not execute query to DB. Failed with the following error: %v", msg))
	}

	if m == nil {
		return echo.NewHTTPError(http.StatusNotFound, "Metadata not found")
	}

	return c.JSON(http.StatusOK, m)
}

func handle(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

func main() {
	cfg := getConfig()
	pool := getPool(cfg)
	server := &Server{pool}

	e := echo.New()
	e.GET("/health", server.Health)
	e.GET("/surveys", server.GetSurveyByParams)
	e.GET("/translators/:surveyid", server.GetTranslator)
	e.POST("/translators", server.CreateTranslator)
	e.GET("/metadata", server.GetMetadata)

	address := fmt.Sprintf(`:%d`, cfg.Port)
	e.Logger.Fatal(e.Start(address))
}

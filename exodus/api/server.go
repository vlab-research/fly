package api

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/vlab-research/exodus/db"
)

// DBInterface defines the database operations needed by the API
type DBInterface interface {
	GetBailsByUser(ctx context.Context, userID uuid.UUID) ([]*db.Bail, error)
	GetBailByID(ctx context.Context, id uuid.UUID) (*db.Bail, error)
	CreateBail(ctx context.Context, bail *db.Bail) error
	UpdateBail(ctx context.Context, bail *db.Bail) error
	DeleteBail(ctx context.Context, id uuid.UUID) error
	GetEventsByBailID(ctx context.Context, bailID uuid.UUID) ([]*db.BailEvent, error)
	GetEventsByUser(ctx context.Context, userID uuid.UUID, limit int) ([]*db.BailEvent, error)
	Query(ctx context.Context, sql string, args ...interface{}) ([]map[string]interface{}, error)
	Close()
}

// Server represents the HTTP API server
type Server struct {
	db   DBInterface
	echo *echo.Echo
}

// New creates a new Server instance with the provided database connection
func New(database DBInterface) *Server {
	e := echo.New()

	// Configure middleware
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())
	e.Use(middleware.CORS())

	// Hide banner
	e.HideBanner = true

	server := &Server{
		db:   database,
		echo: e,
	}

	// Register routes
	server.registerRoutes()

	return server
}

// registerRoutes sets up all HTTP endpoints
func (s *Server) registerRoutes() {
	// Health check
	s.echo.GET("/health", s.Health)

	// User-scoped bail endpoints
	userGroup := s.echo.Group("/users/:userId")
	userGroup.GET("/bails", s.ListBails)
	userGroup.POST("/bails", s.CreateBail)
	userGroup.POST("/bails/preview", s.PreviewBail)
	userGroup.GET("/bails/:id", s.GetBail)
	userGroup.PUT("/bails/:id", s.UpdateBail)
	userGroup.DELETE("/bails/:id", s.DeleteBail)
	userGroup.GET("/bails/:id/events", s.GetBailEvents)
	userGroup.GET("/bail-events", s.GetUserEvents)
}

// Run starts the HTTP server on the specified address (blocking)
func (s *Server) Run(addr string) error {
	return s.echo.Start(addr)
}

// Shutdown gracefully stops the server with the given context
func (s *Server) Shutdown(ctx context.Context) error {
	return s.echo.Shutdown(ctx)
}

// Router returns the echo instance for testing purposes
func (s *Server) Router() *echo.Echo {
	return s.echo
}

// respondError sends a standardized error response
func respondError(c echo.Context, status int, err string, message string) error {
	return c.JSON(status, ErrorResponse{
		Error:   err,
		Message: message,
	})
}

// parseTimeout creates a timeout context for database operations
func parseTimeout(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, 10*time.Second)
}

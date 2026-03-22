package messageworker

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TokenStore retrieves platform access tokens
type TokenStore interface {
	GetToken(ctx context.Context, platformAccountID string) (string, error)
	Close()
}

// ErrTokenNotFound is returned when no token is found for a platform account
var ErrTokenNotFound = fmt.Errorf("token not found for platform account")

// PostgresTokenStore implements TokenStore using database lookup with caching
type PostgresTokenStore struct {
	pool  *pgxpool.Pool
	cache *tokenCache
	ttl   time.Duration
}

// tokenCache is a simple TTL cache for tokens
type tokenCache struct {
	mu      sync.RWMutex
	entries map[string]*cacheEntry
}

type cacheEntry struct {
	token     string
	expiresAt time.Time
}

// NewPostgresTokenStore creates a new PostgresTokenStore
func NewPostgresTokenStore(ctx context.Context, databaseURL string, cacheTTL time.Duration) (*PostgresTokenStore, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("failed to create database pool: %w", err)
	}

	// Test connection
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	return &PostgresTokenStore{
		pool: pool,
		cache: &tokenCache{
			entries: make(map[string]*cacheEntry),
		},
		ttl: cacheTTL,
	}, nil
}

// GetToken retrieves the access token for a platform account
// Uses query from old replybot tokenstore.js:
// SELECT details->>'access_token' AS token FROM credentials WHERE facebook_page_id = $1 ORDER BY created DESC LIMIT 1
// Note: testrunner uses 'token' key, production uses 'access_token'
func (s *PostgresTokenStore) GetToken(ctx context.Context, platformAccountID string) (string, error) {
	// Check cache first
	if token, ok := s.cache.get(platformAccountID); ok {
		return token, nil
	}

	// Query database - try access_token first, fall back to token (for testrunner compatibility)
	var token string
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(details->>'access_token', details->>'token') AS token
		FROM credentials
		WHERE facebook_page_id = $1
		ORDER BY created DESC
		LIMIT 1
	`, platformAccountID).Scan(&token)

	if err != nil {
		return "", fmt.Errorf("%w: %s (db error: %v)", ErrTokenNotFound, platformAccountID, err)
	}

	if token == "" {
		return "", fmt.Errorf("%w: %s (empty token)", ErrTokenNotFound, platformAccountID)
	}

	// Cache the token
	s.cache.set(platformAccountID, token, s.ttl)

	return token, nil
}

// Close closes the database pool
func (s *PostgresTokenStore) Close() {
	if s.pool != nil {
		s.pool.Close()
	}
}

// Cache methods
func (c *tokenCache) get(key string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	entry, ok := c.entries[key]
	if !ok {
		return "", false
	}

	if time.Now().After(entry.expiresAt) {
		return "", false
	}

	return entry.token, true
}

func (c *tokenCache) set(key, token string, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.entries[key] = &cacheEntry{
		token:     token,
		expiresAt: time.Now().Add(ttl),
	}
}

// StaticTokenStore implements TokenStore with a static token (for testing/facebot mock)
type StaticTokenStore struct {
	token string
}

// NewStaticTokenStore creates a TokenStore that returns a static token
func NewStaticTokenStore(token string) *StaticTokenStore {
	return &StaticTokenStore{token: token}
}

// GetToken returns the static token
func (s *StaticTokenStore) GetToken(ctx context.Context, platformAccountID string) (string, error) {
	if s.token == "" {
		return "", ErrTokenNotFound
	}
	return s.token, nil
}

// Close is a no-op for static token store
func (s *StaticTokenStore) Close() {}

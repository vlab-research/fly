package messageworker

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TokenStore retrieves platform access tokens
type TokenStore interface {
	GetToken(ctx context.Context, platform, platformAccountID string) (string, error)
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

// GetToken retrieves the access token for a platform account.
// Queries by first-class (platform, account_id) keying, with a dual-read
// fallback to the legacy facebook_page_id computed column during the
// Phase 2 migration window (see planning/whatsapp-plan.md CHUNK 1).
// Note: testrunner uses 'token' key, production uses 'access_token'
func (s *PostgresTokenStore) GetToken(ctx context.Context, platform, platformAccountID string) (string, error) {
	// Check cache first
	cacheKey := platform + ":" + platformAccountID
	if token, ok := s.cache.get(cacheKey); ok {
		return token, nil
	}

	// New pattern: explicit platform + account_id columns
	var token string
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(details->>'access_token', details->>'token') AS token
		FROM credentials
		WHERE platform = $1 AND account_id = $2
		ORDER BY created DESC
		LIMIT 1
	`, platform, platformAccountID).Scan(&token)

	// Dual-read fallback: legacy pattern, for credentials created before the
	// backfill (or by writers not yet setting platform/account_id).
	// Remove in Phase 3 when facebook_page_id is dropped.
	if errors.Is(err, pgx.ErrNoRows) {
		err = s.pool.QueryRow(ctx, `
			SELECT COALESCE(details->>'access_token', details->>'token') AS token
			FROM credentials
			WHERE facebook_page_id = $1
			ORDER BY created DESC
			LIMIT 1
		`, platformAccountID).Scan(&token)
	}

	if err != nil {
		return "", fmt.Errorf("%w: %s/%s (db error: %v)", ErrTokenNotFound, platform, platformAccountID, err)
	}

	if token == "" {
		return "", fmt.Errorf("%w: %s/%s (empty token)", ErrTokenNotFound, platform, platformAccountID)
	}

	// Cache the token
	s.cache.set(cacheKey, token, s.ttl)

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
func (s *StaticTokenStore) GetToken(ctx context.Context, platform, platformAccountID string) (string, error) {
	if s.token == "" {
		return "", ErrTokenNotFound
	}
	return s.token, nil
}

// Close is a no-op for static token store
func (s *StaticTokenStore) Close() {}

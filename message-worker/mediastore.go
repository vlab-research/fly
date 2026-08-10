package messageworker

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vlab-research/fly/message-worker/types"
)

// MediaStore looks up the cached platform media id for one (asset, account).
//
// READ-ONLY BY DESIGN. The worker never writes media state and never touches
// object storage: handles are written by dashboard-server's upload fan-out and
// by the reconciler. See planning/media-abstraction.md §7.
//
// The lookup key is (asset_id, account_id) -- account_id ALONE, with no platform
// component. account_id is credentials.key, which migration 20
// (unique_messaging_account) enforces as globally unique across messaging
// platforms, and which is the same value tokenstore already resolves tokens by.
// Keying on it means the writer and the reader cannot disagree about a spelling.
// See migration 24's comment for the full rationale.
type MediaStore interface {
	// GetHandle returns nil, nil when no handle exists. A miss is an ordinary,
	// expected outcome -- not an error -- because the caller degrades to a URL
	// send.
	GetHandle(ctx context.Context, assetID, accountID string) (*types.MediaHandle, error)
	Close()
}

// PostgresMediaStore implements MediaStore against CockroachDB, using the same
// connection style as PostgresTokenStore.
//
// Deliberately uncached, unlike tokens: handles are refreshed by the reconciler
// and a stale cache entry would mean sending an id we have already replaced. The
// query is a primary-key seek, so the database is the right cache.
type PostgresMediaStore struct {
	pool *pgxpool.Pool
}

// NewPostgresMediaStore creates a MediaStore backed by its own pool.
func NewPostgresMediaStore(ctx context.Context, databaseURL string) (*PostgresMediaStore, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("failed to create media store pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("failed to ping database for media store: %w", err)
	}
	return &PostgresMediaStore{pool: pool}, nil
}

// GetHandle performs the single query this store exists for: a primary-key seek
// on (asset_id, account_id).
//
// Returns (nil, nil) when there is no row. Returns (nil, err) only on a genuine
// database failure -- and even then the caller must treat it as a miss and send
// by URL, which is what makes "the handle layer can fail entirely" true rather
// than aspirational (§13).
func (s *PostgresMediaStore) GetHandle(ctx context.Context, assetID, accountID string) (*types.MediaHandle, error) {
	var h types.MediaHandle
	var mediaID *string

	err := s.pool.QueryRow(ctx, `
		SELECT platform_media_id, expires_at
		FROM media_handle
		WHERE asset_id = $1 AND account_id = $2
	`, assetID, accountID).Scan(&mediaID, &h.ExpiresAt)

	if errors.Is(err, pgx.ErrNoRows) {
		// No handle for this asset on this account. Ordinary: the fan-out may
		// not have reached it, or the account may be new. Send by URL.
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("media handle lookup failed for asset %s account %s: %w", assetID, accountID, err)
	}

	// platform_media_id IS NULL records a known-dead handle. Carry it through as
	// an empty id; Resolve degrades it to a URL send.
	if mediaID != nil {
		h.PlatformMediaID = *mediaID
	}
	return &h, nil
}

// Close closes the database pool.
func (s *PostgresMediaStore) Close() {
	if s.pool != nil {
		s.pool.Close()
	}
}

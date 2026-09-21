package db

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/vlab-research/exodus/platform"
)

// GetMessagingCredentials looks up the messaging credential for each account id,
// keyed by account id (the `key` column, stored as `pageid` elsewhere).
//
// It is deliberately not owner-scoped: the caller distinguishes "no such account"
// from "not yours", which is what produces the two skip reasons. Migration 20's
// unique index on `key` for messaging entities makes the lookup single-valued, so
// one account id has at most one owner and one entity globally.
func (d *DB) GetMessagingCredentials(ctx context.Context, pageids []string) (map[string]platform.Credential, error) {
	creds := make(map[string]platform.Credential, len(pageids))
	if len(pageids) == 0 {
		return creds, nil
	}

	query := `
		SELECT key, entity, userid
		FROM chatroach.credentials
		WHERE key = ANY($1) AND entity IN ('facebook_page', 'whatsapp_business')
	`

	rows, err := d.pool.Query(ctx, query, pageids)
	if err != nil {
		return nil, fmt.Errorf("failed to query messaging credentials: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var key, entity string
		var ownerID uuid.UUID
		if err := rows.Scan(&key, &entity, &ownerID); err != nil {
			return nil, fmt.Errorf("failed to scan messaging credential: %w", err)
		}
		creds[key] = platform.Credential{PageID: key, Entity: entity, OwnerID: ownerID}
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating messaging credentials: %w", err)
	}

	return creds, nil
}

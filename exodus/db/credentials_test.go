package db

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/vlab-research/exodus/platform"
)

// insertCredential creates one credential row. `details` carries the account id
// because migration 01 derives facebook_page_id from it under a unique constraint.
func insertCredential(t *testing.T, pool *pgxpool.Pool, ownerID uuid.UUID, entity, key string) {
	t.Helper()
	MustExec(t, pool, `
		INSERT INTO chatroach.credentials (userid, entity, key, details)
		VALUES ($1, $2, $3, jsonb_build_object('id', $3::string))
	`, ownerID, entity, key)
}

func TestGetMessagingCredentials(t *testing.T) {
	pool := TestPool()
	defer pool.Close()
	Before(pool)

	owner := SetupTestUser(t, pool)
	other := SetupTestUser(t, pool)
	database := &DB{pool: pool}

	insertCredential(t, pool, owner, "facebook_page", "cred-page-fb")
	insertCredential(t, pool, owner, "whatsapp_business", "cred-page-wa")
	insertCredential(t, pool, other, "facebook_page", "cred-page-other")
	insertCredential(t, pool, owner, "api_token", "cred-page-token")

	creds, err := database.GetMessagingCredentials(context.Background(), []string{
		"cred-page-fb", "cred-page-wa", "cred-page-other", "cred-page-token", "cred-page-absent",
	})
	if err != nil {
		t.Fatalf("GetMessagingCredentials failed: %v", err)
	}

	want := map[string]platform.Credential{
		"cred-page-fb":    {PageID: "cred-page-fb", Entity: "facebook_page", OwnerID: owner},
		"cred-page-wa":    {PageID: "cred-page-wa", Entity: "whatsapp_business", OwnerID: owner},
		"cred-page-other": {PageID: "cred-page-other", Entity: "facebook_page", OwnerID: other},
	}

	if len(creds) != len(want) {
		t.Fatalf("got %d credentials (%+v), want %d", len(creds), creds, len(want))
	}
	for key, expected := range want {
		got, ok := creds[key]
		if !ok {
			t.Errorf("missing credential for %q", key)
			continue
		}
		if got != expected {
			t.Errorf("credential for %q = %+v, want %+v", key, got, expected)
		}
	}

	if _, ok := creds["cred-page-token"]; ok {
		t.Error("a non-messaging entity must not be returned: it has no transport to send on")
	}
	if _, ok := creds["cred-page-absent"]; ok {
		t.Error("an account with no credential row must be absent from the map")
	}
}

func TestGetMessagingCredentials_EmptyInput(t *testing.T) {
	pool := TestPool()
	defer pool.Close()
	Before(pool)

	database := &DB{pool: pool}

	creds, err := database.GetMessagingCredentials(context.Background(), nil)
	if err != nil {
		t.Fatalf("GetMessagingCredentials failed: %v", err)
	}
	if creds == nil {
		t.Fatal("empty input must return an empty map, not nil")
	}
	if len(creds) != 0 {
		t.Errorf("got %d credentials, want 0", len(creds))
	}
}

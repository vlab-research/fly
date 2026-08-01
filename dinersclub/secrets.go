package main

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v4"
	"github.com/jackc/pgx/v4/pgxpool"
)

// secretForUser resolves one of a researcher's Generic Secrets by name.
//
// Generic Secrets are the general "researcher holds a credential" mechanism:
// a free-form name mapped to a single string, created in the dashboard under
// Connected Accounts. Providers whose credential is a single opaque value --
// an API key -- should read it from here rather than defining an entity of
// their own, because a bespoke entity needs a bespoke dashboard screen to
// write it, and a provider is unusable until that screen exists.
//
// Providers whose credential is genuinely structured are the exception. The
// Reloadly provider needs an id *and* a secret, which does not fit a single
// string, and that is why it has an entity and a screen of its own. Shape
// decides the mechanism; a single string does not justify either.
//
// The name comes from the survey's `payment.key`, so a wrong name is a
// researcher-visible configuration error. The returned error names the secret
// it looked for, since the failure surfaces at payout time -- while someone is
// waiting to be paid -- and "not found" without a name is not actionable.
func secretForUser(pool *pgxpool.Pool, userid, name string) (string, error) {
	query := `SELECT details->>'value' FROM credentials
	          WHERE entity='secrets' AND userid=$1 AND key=$2 LIMIT 1`

	var value *string
	err := pool.QueryRow(context.Background(), query, userid, name).Scan(&value)

	if err == pgx.ErrNoRows {
		return "", fmt.Errorf(
			`No Generic Secret named %q was found. Create it in the dashboard under Connected Accounts, or correct the "key" in your survey's payment block.`,
			name)
	}
	if err != nil {
		return "", err
	}

	// A secret row can exist with a null or empty value -- the dashboard
	// requires a value on create, but a direct edit can leave one behind. It
	// would otherwise reach the provider as an empty API key and come back as
	// an opaque authentication failure.
	if value == nil || *value == "" {
		return "", fmt.Errorf(`The Generic Secret named %q is empty. Set its value in the dashboard under Connected Accounts.`, name)
	}

	return *value, nil
}

/*
 * API token hardening (VIR-37 phase 1): make researcher API keys revocable,
 * expiring and scopable, so one can be handed to an AI agent.
 *
 * See dashboard-server/api/auth/auth.core.js for the model. In short: the token
 * is never stored, so the credentials row is the only revocable thing, and
 * validity is POSITIVE — a key is live iff its row is live. The `jti` claim is
 * what ties a token to its row.
 *
 * ADDITIVE ONLY. No existing row is rewritten and no existing token is
 * invalidated by this migration.
 *
 * WHY A COMPUTED COLUMN AND NOT A REAL ONE
 *
 * `jti` and `scopes` are written into `details` by the application, which keeps
 * one writer and one shape for the whole api_token record. The column exists
 * only so the verifier's lookup is an index seek instead of a JSONB scan — it
 * is derived, never written. This mirrors `facebook_page_id`, which already
 * does exactly this on this table.
 *
 * WHAT HAPPENS TO EXISTING api_token ROWS
 *
 * Nothing. They keep NULL `api_token_jti` and no `scopes` in `details`, and the
 * verifier treats them as VALID-BUT-UNSCOPED: full account access, no expiry,
 * exactly as today. Nobody's key breaks.
 *
 * They are still revocable, because a legacy token carries the
 * `https://vlab.digital/token-name` claim: with no jti to match, the verifier
 * falls back to requiring a live row for (email, name). The one thing that
 * fallback cannot do is survive name reuse — revoke "foo", create a new "foo",
 * and the old legacy token matches the new row again. That hazard is exactly
 * what `jti` removes, and it applies only to keys minted before this migration.
 * Reissuing a key is the fix.
 *
 * Deliberately NOT backfilled with generated jtis: the tokens already in the
 * wild carry no jti claim, so a jti on their row would match nothing and only
 * make the data look linked when it is not.
 */

/* Derived from details->>'jti'. Written by nothing; read by the verifier. */
ALTER TABLE chatroach.credentials
      ADD COLUMN IF NOT EXISTS api_token_jti VARCHAR
      AS (CASE WHEN entity = 'api_token' THEN details->>'jti' ELSE NULL END) STORED;

/*
 * Partial, like unique_messaging_account above it: every non-api_token row and
 * every legacy api_token row has a NULL jti, and none of them belong in this
 * index. STORING makes the verifier's hot path — jti -> owner + scopes — an
 * index-only read.
 *
 * UNIQUE is an integrity guard rather than a requirement: jti is a server-side
 * uuid, so a duplicate means a bug, and this turns that bug into an error
 * instead of an ambiguous lookup.
 */
CREATE UNIQUE INDEX IF NOT EXISTS unique_api_token_jti
    ON chatroach.credentials (api_token_jti)
    STORING (details, userid)
    WHERE api_token_jti IS NOT NULL;

/*
 *****************
 * Permissions
 *
 * DELETE is the grant that matters: 01-init.sql granted only INSERT, SELECT,
 * UPDATE, and revocation is a delete of the api_token row.
 *
 * A soft-delete flag on `details` would have needed no new grant, but
 * UNIQUE(entity, key) means a soft-deleted key holds its name forever — you
 * could revoke "mcp-agent" and then never create another key called
 * "mcp-agent". Deleting the row frees the name; the jti is what keeps the old
 * token from coming back to life with it.
 *****************
 */
GRANT DELETE ON TABLE chatroach.credentials TO chatroach;

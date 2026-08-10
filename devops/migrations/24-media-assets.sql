/*
 * Media abstraction: replace the page-scoped `media` table with an
 * asset/handle model.
 *
 * See planning/media-abstraction.md §5 for the full rationale.
 *
 * THE MODEL
 *
 *   media_asset  -- immutable. The bytes, plus a stable public URL we serve.
 *                   Platform- and account-independent. This is what a survey
 *                   references. Losing it loses the researcher's library.
 *
 *   media_handle -- volatile cache. One platform media id per (asset, account).
 *                   A handle is ALWAYS an optimisation, never a requirement:
 *                   you can DELETE FROM media_handle at any moment and nothing
 *                   breaks, because every send degrades to a URL send and the
 *                   reconciler refills on the next tick.
 *
 * That difference in durability -- not asset-vs-handle so much as immutable-vs-
 * volatile -- is why these are two tables rather than one discriminated table.
 *
 * WHY THE OLD TABLE IS DROPPED RATHER THAN MIGRATED
 *
 * Its rows cannot participate in the new model: they carry an attachment_id but
 * no bytes in storage, no content_hash and no key -- and Meta offers no download
 * for an attachment id, so they can never be backfilled into assets. They would
 * become a third row shape every query has to exclude.
 *
 * Verified against production before writing this migration: 72 rows across 3
 * owners. Dropping loses list-view history and nothing else -- the send path
 * reads attachment_id from SURVEY JSON, never from this table, so no message
 * delivery depends on it. Legacy attachment_id surveys keep working untouched.
 */

DROP TABLE IF EXISTS chatroach.media;

-- Immutable facts about bytes. Write-once, never updated.
-- Owned by the dashboard; read by the media tab.
CREATE TABLE IF NOT EXISTS chatroach.media_asset(
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    userid       UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
    content_hash VARCHAR NOT NULL,        -- dedupe DETECTION only, never identity
    media_type   VARCHAR NOT NULL,        -- image | video | audio | file
    mime_type    VARCHAR NOT NULL,
    byte_size    INT NOT NULL,
    filename     VARCHAR NOT NULL,
    created      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Per-researcher, NOT global. Global uniqueness would mean two researchers
    -- uploading the same image share one row, and the second one's media tab --
    -- which filters by userid -- would not show their own file.
    UNIQUE (userid, content_hash),
    INDEX (userid, created DESC)
);

/*
 * Volatile cache state per (asset, account).
 * Written by upload fan-out and the reconciler; read only by message-worker.
 *
 * KEYED ON account_id ALONE, NOT (platform, account_id).
 *
 * account_id is credentials.key -- the facebook page_id or whatsapp
 * phone_number_id -- which migration 20 (unique_messaging_account) enforces as
 * globally unique across messaging platforms.
 *
 * DEPENDENCY: this table's key correctness rests on that index. If
 * unique_messaging_account is ever dropped, handles can collide across
 * platforms. See 20-messaging-account-unique.sql.
 *
 * A two-part key would have been a silent-failure trap. This codebase spells the
 * platform two ways -- 'messenger'/'whatsapp' in SendMessageCommand, versus
 * 'facebook_page'/'whatsapp_business' in credentials.entity, with
 * message-worker/tokenstore.go translating between them. Fan-out iterates
 * credentials (holding 'facebook_page') while the worker sends a command
 * (holding 'messenger'), so a (platform, account_id) key invites the writer and
 * the reader to disagree -- and the failure is INVISIBLE, because a lookup miss
 * is not an error, it is the designed URL fallback. Every message would still
 * deliver while the handle layer quietly did nothing.
 *
 * account_id has exactly one spelling, and the write and read sides already
 * agree on it in production: tokenstore resolves access tokens by that same
 * equality, so if it did not hold, no message would send at all.
 *
 * platform remains as a DESCRIPTIVE column -- which endpoint uploaded this,
 * useful for debugging and reconciler reporting -- and is never a lookup key.
 *
 * No FK on account_id: a partial unique index cannot back one, and credentials
 * rotate. A stale handle for a disconnected account is simply never looked up;
 * the reconciler prunes it.
 */
CREATE TABLE IF NOT EXISTS chatroach.media_handle(
    asset_id          UUID NOT NULL REFERENCES chatroach.media_asset(id) ON DELETE CASCADE,
    account_id        VARCHAR NOT NULL,   -- credentials.key; globally unique per migration 20
    platform          VARCHAR NOT NULL,   -- descriptive only, never a lookup key
    platform_media_id VARCHAR,            -- NULL = known-dead, send by URL
    uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- BOTH platforms expire. Verified against Meta docs 2026-08-10:
    -- WhatsApp media ids 30 days, Messenger attachment ids 90 days
    -- ("Attachment IDs expire after 90 days" -- messenger-platform/send-messages/saving-assets).
    -- An earlier draft of this design recorded Messenger as "no known expiry",
    -- which would have meant Messenger handles were never refreshed: they would
    -- die silently at 90 days and every send would fall back to URL forever,
    -- with nothing erroring. NULL here now means only "expiry genuinely unknown",
    -- which no current platform should produce.
    expires_at        TIMESTAMPTZ,

    -- Enforces "exactly one handle per (asset, account)" in the database rather
    -- than by query discipline, which is what makes reconcile idempotent by
    -- construction (INSERT ... ON CONFLICT DO UPDATE) and makes the worker's
    -- lookup a pure equality seek -- no ORDER BY, no dependence on cross-node
    -- clock ordering.
    PRIMARY KEY (asset_id, account_id),
    INDEX (expires_at)                    -- reconciler sweep
);

/*
 *****************
 * Permissions
 *
 * UPDATE is the grant that matters: 10-media.sql granted only INSERT, SELECT,
 * which cannot support handle refresh.
 *****************
 */
GRANT SELECT ON TABLE chatroach.media_asset  TO chatreader;
GRANT SELECT ON TABLE chatroach.media_handle TO chatreader;
GRANT INSERT, SELECT, UPDATE, DELETE ON TABLE chatroach.media_asset  TO chatroach;
GRANT INSERT, SELECT, UPDATE, DELETE ON TABLE chatroach.media_handle TO chatroach;

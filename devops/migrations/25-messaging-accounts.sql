-- 25-messaging-accounts.sql
--
-- The messaging account registry. See planning/conversation-identity.md §5 and
-- documentation/messaging-accounts.md.
--
-- WHAT THIS OWNS
--
-- "Which messaging accounts do we send and receive on, and whose are they."
-- Today that question is answered by a partial unique index bolted onto the
-- generic credential store (20-messaging-account-unique.sql):
--
--     UNIQUE INDEX unique_messaging_account ON chatroach.credentials (key)
--       STORING (details, userid)
--       WHERE entity IN ('facebook_page', 'whatsapp_business');
--
-- `credentials` is a generic key/value store -- it also holds api_token,
-- reloadly, secrets, typeform_token, facebook_ad_user. How a subsystem uses a
-- credential is that subsystem's business, so the messaging invariant belongs in
-- a messaging-owned table that POINTS AT a credential rather than in a predicate
-- welded into the shared store.
--
-- PRIMARY KEY (platform, account_id) -- AND WHY THIS REVERSES A RATIFIED DECISION
--
-- documentation/platform-abstraction.md recorded a ratified decision (2026-07-22)
-- that account identity is (allocator, id) serialized to ONE opaque string, and
-- explicitly REJECTED first-class (platform, account_id) pairs on the grounds
-- that "platform is an attribute of an account, never part of its identity."
--
-- That decision is reversed here, deliberately. Be clear about why, because the
-- original reasoning was not wrong on its own terms:
--
--   * NONE of the three tripwires the ratified decision named have fired. There
--     is no allocator whose ids cannot be prefix-encoded, no need to shard by
--     platform, and NO observed uniqueness failure. Verified in production
--     2026-08-17: zero duplicate `key` values across both messaging entities.
--   * The id-uniqueness argument is still CORRECT. Meta is one allocator across
--     page ids and phone_number_ids, and a bare Meta id really is unambiguous.
--     Nothing here claims otherwise.
--
-- What carried is a different, structural objection: `entity -> platform` is not
-- a function, so platform cannot be modelled as an attribute OF an account.
-- Instagram is the case. Instagram DMs are delivered through the connected
-- Facebook PAGE's token, so platform='instagram' and platform='messenger' are two
-- platforms sharing ONE credential and ONE entity. If platform were an attribute
-- of an account, an account could not have two of them.
--
-- Sourcing, precisely: our code records only the weaker half --
-- message-worker/translator_instagram.go:10, "Instagram uses the same API
-- structure as Messenger". The Page-token fact is META'S documented model for
-- Instagram messaging on a professional account, not a claim made anywhere in
-- this repo.
--
-- HONESTY ABOUT INSTAGRAM'S STATUS: this is a PROSPECTIVE break, not an observed
-- production failure. Instagram is not live. A translator and a stub client exist
-- (message-worker/translator_instagram.go, main.go:118 "registered Instagram
-- client (stub)"), and PlatformInstagram is in the enum
-- (message-worker/types/command.go:13), but hermes has no Instagram webhook, no
-- instagram credential entity can be registered, and nothing anywhere produces
-- platform='instagram'. The structural claim rests on META'S API design, which is
-- external and stable, not on our dead code.
--
-- The live symptom of the same defect is the hand-written platformToEntity map,
-- duplicated in message-worker/tokenstore.go:29 and dinersclub/provider.go:74,
-- each with a load-bearing fallback for when the platform is "absent or
-- unmapped". This table replaces that map with a column.
--
-- Secondary argument: the invariant's scope is an ALLOWLIST,
-- `entity IN ('facebook_page','whatsapp_business')`, duplicated across six
-- runtime call sites (see documentation/messaging-accounts.md for the verified
-- list -- the planning doc said ten; six is the real number). Add SMS or Telegram
-- and the new entity falls outside every one of those predicates, so its account
-- ids become silently unconstrained. The failure mode is a silent collision, not
-- a rejected INSERT.
--
-- FOREIGN KEY: `campaigns` is the live precedent for the shape --
-- CONSTRAINT credentials_key_exists FOREIGN KEY (userid, credentials_entity,
-- credentials_key) REFERENCES chatroach.credentials (userid, entity, key).
-- The required unique index on the referenced columns exists and was verified in
-- production 2026-08-17: `unique_entity_key_per_user` on
-- (userid ASC, entity ASC, key ASC), a secondary unique constraint declared at
-- 01-init.sql:181. Column order matches the FK declaration, which CockroachDB
-- requires.
--
-- ON DELETE CASCADE ON THAT FK -- A DELIBERATE DEVIATION FROM THE §5.2 DRAFT.
--
-- §5.2 declared the credentials FK with no ON DELETE action. Reproduced against
-- CockroachDB v24.1.28 with the draft DDL verbatim: deleting a messaging
-- credential that has a registry row fails with
--
--     SQLSTATE 23503 ... Key (userid, entity, key)=(...) is still referenced
--     from table "messaging_accounts". CONSTRAINT: credentials_exist
--
-- That makes a credential UNDELETABLE while the registry references it, which
-- breaks three real things:
--
--   1. Reconnecting an account. `credentials` has UNIQUE(entity, key)
--      (01-init.sql:177) and the create path has no ON CONFLICT
--      (credentials.queries.js:87), so re-POSTing an existing page 23505s.
--      Recovery is delete-then-recreate -- which RESTRICT forbids.
--   2. Any future disconnect-account feature, which would fail with an opaque
--      23503 naming a table the operator has never heard of.
--   3. Seven dashboard-server test teardowns that DELETE FROM credentials
--      (e.g. api/states/states.test.js:145, api/media/media.reconcile.
--      integration.test.js:158).
--
-- CASCADE is also the correct semantics, not merely the convenient one: a
-- registry row without its credential is an account that cannot send or receive,
-- so the row is meaningless the moment the credential is gone. And it keeps the
-- registry invariant true by construction under deletion instead of blocking the
-- delete. Note the asymmetry -- CASCADE makes "credential deleted, registry row
-- left behind" impossible, but it does NOT prevent the opposite and more
-- dangerous state, a credential with no registry row. That is the invisible
-- account, and only the recurring check below catches it.
--
-- The double cascade was verified, since `userid` cascades from `users` on BOTH
-- this table and `credentials`: deleting a user removes the credential rows and
-- the registry rows together, no 23503, on v24.1.28.

CREATE TABLE IF NOT EXISTS chatroach.messaging_accounts(
    -- 'messenger' | 'whatsapp' | 'instagram' | ...  The SendMessageCommand
    -- spelling, never the credentials.entity spelling. See the note below.
    platform    VARCHAR NOT NULL,
    -- page_id | phone_number_id. Equal to credentials.key today; kept as its own
    -- column because it is this table's identity, not a denormalisation.
    account_id  VARCHAR NOT NULL,

    userid      UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,

    credentials_entity VARCHAR NOT NULL,
    credentials_key    VARCHAR NOT NULL,

    created     TIMESTAMPTZ NOT NULL DEFAULT current_timestamp(),

    PRIMARY KEY (platform, account_id),

    CONSTRAINT credentials_exist
      FOREIGN KEY (userid, credentials_entity, credentials_key)
      REFERENCES chatroach.credentials (userid, entity, key)
      ON DELETE CASCADE,

    -- ===================================================================
    -- "TRANSITIONAL" -- BUT DO NOT DROP THIS INDEX WITHOUT READING ALL OF
    -- THIS. IT HAS DEPENDANTS THAT ARE NOT VISIBLE FROM THIS FILE.
    -- ===================================================================
    --
    -- Why it exists: six consumers still route on the bare account id and rely
    -- on its global uniqueness (documentation/messaging-accounts.md §5 lists
    -- them with file:line). The intent is that it goes away once they route on
    -- the (platform, account_id) tuple -- dropped FROM HERE, without ever
    -- touching credentials, which is the whole point of moving the invariant
    -- into a domain table. planning/conversation-identity.md §5.5 step 5 says
    -- to drop it.
    --
    -- THE WORD "TRANSITIONAL" IS NOT PERMISSION. Three separate things depend
    -- on this index or on the guarantee it provides, and each fails silently:
    --
    --   1. ACCOUNT -> PLATFORM RESOLUTION (documentation/messaging-accounts.md
    --      §9). `account_id -> platform` is a FUNCTION only because no account
    --      id can appear twice. Drop this index and that lookup becomes
    --      ambiguous -- an account id could match two platform rows and there
    --      is no tiebreak. Anything resolving a platform from a bare account id
    --      breaks, and it breaks by picking one arbitrarily, not by erroring.
    --
    --   2. media_handle (24-media-assets.sql). It is keyed on `account_id`
    --      ALONE and its header states the dependency outright: "If
    --      unique_messaging_account is ever dropped, handles can collide across
    --      platforms." Note the sequencing trap -- TODAY that guarantee comes
    --      from 20-messaging-account-unique.sql on `credentials`, NOT from this
    --      index. §5.5 step 5 drops BOTH. The moment migration 20's index is
    --      dropped, THIS index becomes the sole enforcer of the invariant
    --      media_handle rests on. So the two drops are not independent: dropping
    --      20 alone is safe, dropping this one alone breaks (1), and dropping
    --      both breaks media_handle -- where the failure is invisible, because a
    --      handle miss is the designed URL fallback rather than an error.
    --
    --   3. The account-id namespace/prefix policy in
    --      documentation/platform-abstraction.md. Prefixing (`sms:`, `tg:`)
    --      exists to keep bare ids unique for single-field consumers. This index
    --      is what enforces it. The policy and this index retire TOGETHER;
    --      dropping the index early means unprefixed ids silently collide.
    --
    -- BEFORE DROPPING: all six consumers route on the tuple, resolution either
    -- retired or given another mechanism, media_handle re-keyed or the
    -- guarantee re-established elsewhere, and the prefix policy formally
    -- retired. Dropping it is also what finally ADMITS a deliberately reused id
    -- across two channels (the same phone number on `sms:` and `signal:`), which
    -- is the capability being bought -- so this is a real milestone, not cleanup.
    --
    -- While it exists it constrains the Instagram case: an igsid must differ
    -- from the page id it shares a credential with. True in practice, but it is
    -- an assumption, and it is THIS INDEX -- not the primary key -- that would
    -- reject a violation. Verified on v24.1.28: ('messenger', page_id) plus
    -- ('instagram', igsid) both insert against one credential; ('instagram',
    -- page_id) is rejected 23505 on this index.
    UNIQUE INDEX global_account_id (account_id),

    -- "list this researcher's accounts", the dashboard's read pattern.
    INDEX by_owner (userid, platform)
);

/*
 *****************
 * Backfill
 *
 * Lives in the same migration as the table, on purpose: the registry is only
 * safe to read once it is COMPLETE, and a window where the table exists but is
 * empty is a window where a reader sees "this account does not exist". Table and
 * contents land together or not at all.
 *
 * `key` IS the account id for both messaging entities. Verified in production
 * 2026-08-17: 62 facebook_page + 2 whatsapp_business = 64 rows, and 64/64 have
 * `key = details->>'id'` with zero NULL ids. (An earlier doc recorded 63
 * facebook_page; that count is stale, not wrong-at-the-time.)
 *
 * ON CONFLICT DO NOTHING makes re-running a clean no-op, which is what keeps
 * this whole file idempotent -- CREATE TABLE IF NOT EXISTS would otherwise be
 * paired with an INSERT that 23505s on the second run. On a fresh database
 * (test harnesses, `make test-db`) there are no credentials at all and both
 * branches select zero rows.
 *****************
 */
INSERT INTO chatroach.messaging_accounts
  (platform, account_id, userid, credentials_entity, credentials_key, created)
SELECT 'messenger', key, userid, entity, key, created
FROM chatroach.credentials WHERE entity = 'facebook_page'
UNION ALL
SELECT 'whatsapp', key, userid, entity, key, created
FROM chatroach.credentials WHERE entity = 'whatsapp_business'
ON CONFLICT DO NOTHING;

/*
 *****************
 * Permissions
 *
 * Matching 24-media-assets.sql. DELETE is granted because the registry follows
 * account lifecycle -- disconnecting an account must be able to remove its row
 * without an admin.
 *****************
 */
GRANT SELECT ON TABLE chatroach.messaging_accounts TO chatreader;
GRANT INSERT, SELECT, UPDATE, DELETE ON TABLE chatroach.messaging_accounts TO chatroach;

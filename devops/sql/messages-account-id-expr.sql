-- Derive chatroach.messages.account_id from a historical `content` blob.
--
-- A SINGLE SQL EXPRESSION over a VARCHAR column named `content`. It is not a
-- runnable statement on its own; it is substituted into a statement by its two
-- consumers, which is the point:
--
--   1. devops/backfill (Go)                 -- the batched UPDATE
--   2. scribble/account_test.go             -- TestBackfillSQLMatchesGo, which
--      evaluates THIS FILE against the shared fixture vectors and asserts it
--      agrees with ConversationFromHistoricalContent in scribble/account.go
--
-- Keeping it in one file is what makes (2) meaningful. If the SQL and the Go
-- drift, a test fails. See scribble/account.go for the prose spec and the
-- production shape census.
--
-- THE RULE, per documentation/event-envelope.md:
--   WhatsApp   account_id = phone_number_id
--   Messenger  account_id = message.is_echo === true ? sender.id : recipient.id
--   Synthetic  account_id = page   (the deprecated alias for account_id)
--
-- NULL means "not derivable" and is a legitimate, terminal answer for a row
-- whose account was never recorded. It is NOT coerced to '' -- see the
-- Conversation doc comment in scribble/account.go for why messages differs from
-- chat_log and responses here.
--
-- The json_valid guard is load-bearing: `content` is 106M rows of archived
-- payload going back to 2020, and an unguarded ::JSONB cast on one malformed row
-- raises 22P02 and kills the whole 20,000-row batch -- permanently, since the
-- next attempt would select the same poison row. json_valid is a CockroachDB
-- v24.1 builtin (verified against production).
CASE
  WHEN NOT json_valid(content) THEN NULL

  -- Already normalized: hermes stamped it. Respected first so the backfill is
  -- idempotent and never overwrites an account derived with certainty.
  WHEN coalesce(content::JSONB->>'account_id', '') != ''
    THEN content::JSONB->>'account_id'

  WHEN content::JSONB->>'source' = 'whatsapp'
    THEN nullif(coalesce(content::JSONB->>'phone_number_id', ''), '')

  -- The echo inversion. An echo is a message the ACCOUNT sent, so the roles
  -- invert and the account is the sender. Strictly `= 'true'`: an absent
  -- `message` object (postbacks, referrals, delivery receipts, handovers) and an
  -- explicit is_echo:false both take the recipient branch. This branch is 28.8%
  -- of the table -- roughly 30M rows -- not an edge case.
  WHEN content::JSONB->>'source' = 'messenger'
    THEN CASE
           WHEN content::JSONB->'message'->>'is_echo' = 'true'
             THEN nullif(coalesce(content::JSONB->'sender'->>'id', ''), '')
           ELSE nullif(coalesce(content::JSONB->'recipient'->>'id', ''), '')
         END

  WHEN content::JSONB->>'source' = 'synthetic'
    THEN nullif(coalesce(content::JSONB->>'page', ''), '')

  ELSE NULL
END

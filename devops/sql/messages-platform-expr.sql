-- Derive chatroach.messages.platform from a historical `content` blob.
--
-- Companion to messages-account-id-expr.sql -- read that file's header first for
-- what these expression files are, who substitutes them, and why they are single
-- files rather than duplicated SQL.
--
-- THE RULE, per documentation/event-envelope.md:
--   WhatsApp   platform = 'whatsapp'   (certain from the shape)
--   Messenger  platform = 'messenger'  (certain from the shape)
--   Synthetic  platform = the POSTed `platform`, which is usually ABSENT
--
-- The synthetic case is the reason this column is mostly NULL after a backfill,
-- and that is correct rather than a gap. `platform` was optional on the
-- /synthetic contract and only dean ever sent it: 84 of 200,000 sampled rows.
-- The transport of a synthetic event is genuinely unrecorded in history.
--
-- It is NOT guessed. The account id could be resolved to a platform through the
-- messaging-account registry, but that is a different phase's work (plan §5/§7.6)
-- and it would write an inference into an archival table as though it were
-- observed. `platform` is stored here rather than derived at read time precisely
-- because history must not be re-derived from mutable current state --
-- `credentials` cascades on user delete, so a deleted researcher would otherwise
-- strip the platform binding from history (plan §3.1). Writing a guess would
-- defeat the reason the column exists.
CASE
  WHEN NOT json_valid(content) THEN NULL

  -- Already normalized: hermes stamped it. Kept consistent with the account
  -- expression's first branch so the two never disagree about which source of
  -- truth a row is using.
  WHEN coalesce(content::JSONB->>'account_id', '') != ''
    THEN nullif(coalesce(content::JSONB->>'platform', ''), '')

  WHEN content::JSONB->>'source' = 'whatsapp'  THEN 'whatsapp'
  WHEN content::JSONB->>'source' = 'messenger' THEN 'messenger'

  WHEN content::JSONB->>'source' = 'synthetic'
    THEN nullif(coalesce(content::JSONB->>'platform', ''), '')

  ELSE nullif(coalesce(content::JSONB->>'platform', ''), '')
END

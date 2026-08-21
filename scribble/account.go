package main

import (
	"encoding/json"
)

// Conversation identity for an archived event: the (platform, account_id) half
// of the triple (platform, account_id, user_id). The user id arrives separately
// -- it is the Kafka key -- so it is deliberately not part of this type.
//
// Empty string means "not derivable". It is never a valid account or platform,
// and it is rendered as SQL NULL by AccountID()/Platform(). A conversation is
// never recorded under a name that could not be verified: an empty-string
// sentinel here would be a poisoned identity, silently grouping every
// unattributable event into one fake conversation.
//
// That differs deliberately from chat_log and responses, which DO coerce an
// absent account to the empty-string sentinel (accountOrUnknown, chatlog.go).
// There the column is
// part of the primary key and NULL is illegal, so a sentinel is the only option.
// messages keeps PRIMARY KEY (hsh, userid) -- see the header of
// devops/migrations/26-messages-account.sql for why -- so account_id stays
// nullable and can say "unknown" honestly.
type Conversation struct {
	Account  string
	Platform string
}

// AccountID renders the account for the messages.account_id column, NULL when
// it could not be derived.
func (c Conversation) AccountID() *string { return nullIfEmpty(c.Account) }

// Platform renders the transport for the messages.platform column, NULL when it
// could not be derived.
func (c Conversation) PlatformOrNil() *string { return nullIfEmpty(c.Platform) }

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// envelope is the subset of the chat-events body that carries conversation
// identity, across all three shapes. Every field is optional: this parses
// production data going back to 2020, and a shape that predates a field must
// yield "not derivable" rather than an error.
type envelope struct {
	// Normalized top-level fields, stamped by hermes on every event as of the
	// envelope work (documentation/event-envelope.md). The only fields the
	// forward path reads.
	AccountID *CastString `json:"account_id"`
	Platform  string      `json:"platform"`

	// Per-shape fields, kept in place by the envelope work precisely so the
	// backfill and the forward path can read the same source. Read only by the
	// historical path.
	Source        string      `json:"source"`
	PhoneNumberID *CastString `json:"phone_number_id"`
	Page          *CastString `json:"page"`
	Sender        *actor      `json:"sender"`
	Recipient     *actor      `json:"recipient"`
	Message       *messageObj `json:"message"`
}

type actor struct {
	ID *CastString `json:"id"`
}

type messageObj struct {
	IsEcho *bool `json:"is_echo"`
}

func (a *actor) id() string {
	if a == nil || a.ID == nil {
		return ""
	}
	return a.ID.String
}

func str(c *CastString) string {
	if c == nil {
		return ""
	}
	return c.String
}

// isEcho reports whether this is an echo -- a message the ACCOUNT sent rather
// than one the participant sent. Strictly `message.is_echo === true`: an absent
// `message` object (postbacks, referrals, delivery receipts, handovers) and an
// explicit `is_echo: false` both take the non-echo branch. Pinned by the
// postback_no_message_key and explicit_is_echo_false vectors in
// testdata/event-envelope/messenger-account-derivation.json.
func (e *envelope) isEcho() bool {
	return e.Message != nil && e.Message.IsEcho != nil && *e.Message.IsEcho
}

// ConversationFromEnvelope derives conversation identity for the FORWARD path,
// from the normalized top-level `account_id` and `platform` fields alone.
//
// Deliberately no fallback to per-shape extraction, to `source`, or to anything
// else. documentation/event-envelope.md makes the envelope the single source
// precisely so that a producer which stops stamping the fields fails loudly
// (a NULL column, visible to the drain query in migration 26) instead of being
// silently papered over by a second extraction path that happens to agree.
//
// Pure: no IO, no error return. Malformed JSON yields "not derivable", which is
// the correct answer for a body we cannot read. Archival must not drop a row
// because its identity is unreadable -- the row is the evidence.
func ConversationFromEnvelope(body []byte) Conversation {
	e := new(envelope)
	if err := json.Unmarshal(body, e); err != nil {
		return Conversation{}
	}
	return Conversation{Account: str(e.AccountID), Platform: e.Platform}
}

// ConversationFromHistoricalContent derives conversation identity for rows
// archived BEFORE hermes stamped the normalized fields, by reading the
// per-shape account field the envelope work kept in place.
//
// THIS IS THE EXECUTABLE SPECIFICATION OF THE BACKFILL. The backfill itself
// runs as SQL (devops/sql/messages-account-expr.sql) because it has to execute
// inside the cluster with only a `cockroach sql` client available -- there is no
// Go toolchain in the migration path. Rather than trusting two implementations
// to agree, TestBackfillSQLMatchesGo executes that exact SQL file against the
// same shared fixture vectors this function is tested on and asserts the two
// produce identical results. Drift is therefore a test failure, not a
// production surprise.
//
// Shape census over a uniform 400k-row sample of production (the primary key is
// (hsh, userid) with hsh = fnv64a(content), so an unordered LIMIT is a uniform
// random sample by construction), measured 2026-08-17:
//
//	synthetic                    197,715   49.4%
//	messenger, is_echo: true     115,134   28.8%   <- the echo branch
//	messenger, no is_echo         86,116   21.5%
//	whatsapp                       1,035    0.26%
//
// The echo branch is over a quarter of the table -- roughly 30M rows -- not an
// edge case. `source` was present on 100% of the sample.
func ConversationFromHistoricalContent(body []byte) Conversation {
	e := new(envelope)
	if err := json.Unmarshal(body, e); err != nil {
		return Conversation{}
	}

	// A row already carrying the normalized field wins, so the backfill is
	// idempotent and never overwrites what hermes derived with certainty.
	if a := str(e.AccountID); a != "" {
		return Conversation{Account: a, Platform: e.Platform}
	}

	switch e.Source {
	case "whatsapp":
		return Conversation{Account: str(e.PhoneNumberID), Platform: "whatsapp"}

	case "messenger":
		// The echo inversion: an echo is a message the PAGE sent, so the roles
		// invert and the account is the sender.
		if e.isEcho() {
			return Conversation{Account: e.Sender.id(), Platform: "messenger"}
		}
		return Conversation{Account: e.Recipient.id(), Platform: "messenger"}

	case "synthetic":
		// `page` is the deprecated alias for account_id. platform was optional
		// on synthetic events and only dean ever sent it, so it is usually
		// absent -- NULL rather than a guess. Deriving it from the account would
		// mean consulting the registry, which is a different phase's work.
		return Conversation{Account: str(e.Page), Platform: e.Platform}
	}

	// Unknown or absent `source`. Fall back to the normalized platform if the
	// row happens to carry one; the account stays unknown.
	return Conversation{Platform: e.Platform}
}

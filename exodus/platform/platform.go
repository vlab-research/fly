// Package platform resolves a messaging account to the transport a bail can
// send on. It is the pure core: no IO, no context, no database.
//
// The authoritative account -> transport map is chatroach.credentials.entity,
// keyed by credentials.key (the account id, stored as `pageid` elsewhere).
package platform

import (
	"sort"

	"github.com/google/uuid"
)

// Messaging credential entities and the transports they send on.
const (
	EntityFacebookPage     = "facebook_page"
	EntityWhatsAppBusiness = "whatsapp_business"

	Messenger = "messenger"
	WhatsApp  = "whatsapp"
)

// Reasons a target could not be resolved to a transport.
const (
	ReasonNotFound     = "credential_not_found"
	ReasonNotOwned     = "credential_not_owned"
	ReasonNotMessaging = "credential_not_messaging"
)

// Credential is one messaging account's entry in chatroach.credentials.
type Credential struct {
	PageID  string
	Entity  string
	OwnerID uuid.UUID
}

// Target is a conversation a bail intends to reach, before its platform is known.
type Target struct {
	UserID          string
	PageID          string
	DestinationForm string
}

// Resolved is a Target whose platform came from its account's credential.
type Resolved struct {
	UserID          string
	PageID          string
	DestinationForm string
	Platform        string
}

// Skipped records a target that no owned messaging credential could resolve.
// Its JSON tags are the wire shape of the "skipped" entries in a bail event's
// execution_results.
type Skipped struct {
	UserID string `json:"userid"`
	PageID string `json:"pageid"`
	Reason string `json:"reason"`
}

// ForEntity maps a messaging credential's entity to its transport, "" if unknown.
func ForEntity(entity string) string {
	switch entity {
	case EntityFacebookPage:
		return Messenger
	case EntityWhatsAppBusiness:
		return WhatsApp
	default:
		return ""
	}
}

// Valid reports whether p is a transport exodus can send on. Empty is never valid.
func Valid(p string) bool {
	return p == Messenger || p == WhatsApp
}

// Resolve partitions targets by whether owner owns a messaging credential for
// the target's account. Input order is preserved in both results.
func Resolve(targets []Target, creds map[string]Credential, owner uuid.UUID) ([]Resolved, []Skipped) {
	var resolved []Resolved
	var skipped []Skipped

	for _, t := range targets {
		reason, transport := classify(creds, t.PageID, owner)
		if reason != "" {
			skipped = append(skipped, Skipped{UserID: t.UserID, PageID: t.PageID, Reason: reason})
			continue
		}
		resolved = append(resolved, Resolved{
			UserID:          t.UserID,
			PageID:          t.PageID,
			DestinationForm: t.DestinationForm,
			Platform:        transport,
		})
	}

	return resolved, skipped
}

// UnresolvedPageIDs returns the distinct pageids, sorted, that owner has no
// messaging credential for. Used by create/update/preview validation.
func UnresolvedPageIDs(pageids []string, creds map[string]Credential, owner uuid.UUID) []string {
	seen := make(map[string]struct{}, len(pageids))
	var bad []string

	for _, pageid := range pageids {
		if _, ok := seen[pageid]; ok {
			continue
		}
		seen[pageid] = struct{}{}
		if reason, _ := classify(creds, pageid, owner); reason != "" {
			bad = append(bad, pageid)
		}
	}

	sort.Strings(bad)
	return bad
}

// classify returns either a skip reason or the transport for one account.
// A credential whose entity has no transport is reported rather than resolved:
// the queries that build creds filter on messaging entities, so an unmapped one
// means that filter changed, and an empty platform must never reach the wire.
func classify(creds map[string]Credential, pageid string, owner uuid.UUID) (reason string, transport string) {
	cred, ok := creds[pageid]
	if !ok {
		return ReasonNotFound, ""
	}
	if cred.OwnerID != owner {
		return ReasonNotOwned, ""
	}
	transport = ForEntity(cred.Entity)
	if transport == "" {
		return ReasonNotMessaging, ""
	}
	return "", transport
}

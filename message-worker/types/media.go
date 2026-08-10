package types

import "time"

// This file holds the DATA of the media handle layer. The LOGIC that decides
// between these shapes lives in the mediaresolve package, which is pure and
// clock-injected. Keeping the types here keeps `types` a leaf package: nothing
// it defines imports anything of ours.

// MediaSendKind is how a media message should be addressed on the wire.
type MediaSendKind int

const (
	// MediaByURL sends the asset's public URL. Always available, always
	// correct -- this is the fallback that makes the whole handle layer
	// optional.
	MediaByURL MediaSendKind = iota
	// MediaByID sends a platform-issued media id, sparing the platform a fetch.
	MediaByID
)

// String returns the metric label for this kind. These values are the labels on
// the by-URL counter, which is the health signal for the entire handle layer:
// a by-URL send for dashboard-uploaded media is an anomaly and should sit near
// zero. Renaming one silently breaks the dashboard.
func (k MediaSendKind) String() string {
	if k == MediaByID {
		return "by_id"
	}
	return "by_url"
}

// MediaHandle is the cached platform media id for one (asset, account), as
// stored in chatroach.media_handle.
type MediaHandle struct {
	// PlatformMediaID is empty when the row records a known-dead handle
	// (platform_media_id IS NULL).
	PlatformMediaID string
	// ExpiresAt is nil when no expiry is known (Messenger).
	ExpiresAt *time.Time
}

// MediaSendable is the resolved decision for one media message. When Kind is
// MediaByURL only URL is set; when MediaByID only ID is set.
//
// It is carried on SendMessageCommand rather than passed as a second translator
// argument so that "everything translation needs is in the command" stays true,
// and so the existing translator signatures -- and the regression tests pinned
// to them -- do not churn.
type MediaSendable struct {
	Kind MediaSendKind
	URL  string
	ID   string
}

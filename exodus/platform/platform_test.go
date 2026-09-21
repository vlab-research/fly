package platform

import (
	"reflect"
	"testing"

	"github.com/google/uuid"
)

func TestForEntity(t *testing.T) {
	tests := []struct {
		entity string
		want   string
	}{
		{EntityFacebookPage, Messenger},
		{EntityWhatsAppBusiness, WhatsApp},
		{"api_token", ""},
		{"", ""},
		{"FACEBOOK_PAGE", ""},
	}

	for _, tt := range tests {
		t.Run(tt.entity, func(t *testing.T) {
			if got := ForEntity(tt.entity); got != tt.want {
				t.Errorf("ForEntity(%q) = %q, want %q", tt.entity, got, tt.want)
			}
		})
	}
}

func TestValid(t *testing.T) {
	tests := []struct {
		platform string
		want     bool
	}{
		{Messenger, true},
		{WhatsApp, true},
		{"", false},
		{"telegram", false},
		{"Messenger", false},
	}

	for _, tt := range tests {
		t.Run(tt.platform, func(t *testing.T) {
			if got := Valid(tt.platform); got != tt.want {
				t.Errorf("Valid(%q) = %v, want %v", tt.platform, got, tt.want)
			}
		})
	}
}

func TestResolve(t *testing.T) {
	owner := uuid.New()
	other := uuid.New()

	fbPage := Credential{PageID: "p_fb", Entity: EntityFacebookPage, OwnerID: owner}
	waPage := Credential{PageID: "p_wa", Entity: EntityWhatsAppBusiness, OwnerID: owner}
	otherPage := Credential{PageID: "p_other", Entity: EntityFacebookPage, OwnerID: other}
	tokenPage := Credential{PageID: "p_token", Entity: "api_token", OwnerID: owner}

	creds := map[string]Credential{
		"p_fb":    fbPage,
		"p_wa":    waPage,
		"p_other": otherPage,
		"p_token": tokenPage,
	}

	tests := []struct {
		name         string
		targets      []Target
		creds        map[string]Credential
		wantResolved []Resolved
		wantSkipped  []Skipped
	}{
		{
			name:         "empty input",
			targets:      nil,
			creds:        creds,
			wantResolved: nil,
			wantSkipped:  nil,
		},
		{
			name:         "no credential at all",
			targets:      []Target{{UserID: "u1", PageID: "p_missing", DestinationForm: "f1"}},
			creds:        creds,
			wantResolved: nil,
			wantSkipped:  []Skipped{{UserID: "u1", PageID: "p_missing", Reason: ReasonNotFound}},
		},
		{
			name:         "empty credential map skips everything",
			targets:      []Target{{UserID: "u1", PageID: "p_fb", DestinationForm: "f1"}},
			creds:        map[string]Credential{},
			wantResolved: nil,
			wantSkipped:  []Skipped{{UserID: "u1", PageID: "p_fb", Reason: ReasonNotFound}},
		},
		{
			name:    "owned facebook_page resolves to messenger",
			targets: []Target{{UserID: "u1", PageID: "p_fb", DestinationForm: "f1"}},
			creds:   creds,
			wantResolved: []Resolved{
				{UserID: "u1", PageID: "p_fb", DestinationForm: "f1", Platform: Messenger},
			},
			wantSkipped: nil,
		},
		{
			name:    "owned whatsapp_business resolves to whatsapp",
			targets: []Target{{UserID: "u1", PageID: "p_wa", DestinationForm: "f1"}},
			creds:   creds,
			wantResolved: []Resolved{
				{UserID: "u1", PageID: "p_wa", DestinationForm: "f1", Platform: WhatsApp},
			},
			wantSkipped: nil,
		},
		{
			name:         "credential owned by another user",
			targets:      []Target{{UserID: "u1", PageID: "p_other", DestinationForm: "f1"}},
			creds:        creds,
			wantResolved: nil,
			wantSkipped:  []Skipped{{UserID: "u1", PageID: "p_other", Reason: ReasonNotOwned}},
		},
		{
			name:         "owned credential that is not a messaging entity",
			targets:      []Target{{UserID: "u1", PageID: "p_token", DestinationForm: "f1"}},
			creds:        creds,
			wantResolved: nil,
			wantSkipped:  []Skipped{{UserID: "u1", PageID: "p_token", Reason: ReasonNotMessaging}},
		},
		{
			name: "mixed batch preserves input order in both results",
			targets: []Target{
				{UserID: "u1", PageID: "p_fb", DestinationForm: "f1"},
				{UserID: "u2", PageID: "p_missing", DestinationForm: "f2"},
				{UserID: "u3", PageID: "p_wa", DestinationForm: "f3"},
				{UserID: "u4", PageID: "p_other", DestinationForm: "f4"},
				{UserID: "u5", PageID: "p_fb", DestinationForm: "f5"},
			},
			creds: creds,
			wantResolved: []Resolved{
				{UserID: "u1", PageID: "p_fb", DestinationForm: "f1", Platform: Messenger},
				{UserID: "u3", PageID: "p_wa", DestinationForm: "f3", Platform: WhatsApp},
				{UserID: "u5", PageID: "p_fb", DestinationForm: "f5", Platform: Messenger},
			},
			wantSkipped: []Skipped{
				{UserID: "u2", PageID: "p_missing", Reason: ReasonNotFound},
				{UserID: "u4", PageID: "p_other", Reason: ReasonNotOwned},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resolved, skipped := Resolve(tt.targets, tt.creds, owner)
			if !reflect.DeepEqual(resolved, tt.wantResolved) {
				t.Errorf("resolved = %+v, want %+v", resolved, tt.wantResolved)
			}
			if !reflect.DeepEqual(skipped, tt.wantSkipped) {
				t.Errorf("skipped = %+v, want %+v", skipped, tt.wantSkipped)
			}
		})
	}
}

func TestUnresolvedPageIDs(t *testing.T) {
	owner := uuid.New()
	other := uuid.New()

	creds := map[string]Credential{
		"p_fb":    {PageID: "p_fb", Entity: EntityFacebookPage, OwnerID: owner},
		"p_wa":    {PageID: "p_wa", Entity: EntityWhatsAppBusiness, OwnerID: owner},
		"p_other": {PageID: "p_other", Entity: EntityFacebookPage, OwnerID: other},
		"p_token": {PageID: "p_token", Entity: "api_token", OwnerID: owner},
	}

	tests := []struct {
		name    string
		pageids []string
		want    []string
	}{
		{name: "empty input", pageids: nil, want: nil},
		{name: "all owned", pageids: []string{"p_fb", "p_wa"}, want: nil},
		{name: "missing credential", pageids: []string{"p_fb", "p_zzz"}, want: []string{"p_zzz"}},
		{name: "owned by another user", pageids: []string{"p_other"}, want: []string{"p_other"}},
		{name: "not a messaging entity", pageids: []string{"p_token"}, want: []string{"p_token"}},
		{
			name:    "several bad, deduplicated and sorted",
			pageids: []string{"p_zzz", "p_other", "p_fb", "p_zzz", "p_aaa"},
			want:    []string{"p_aaa", "p_other", "p_zzz"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := UnresolvedPageIDs(tt.pageids, creds, owner)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("UnresolvedPageIDs() = %v, want %v", got, tt.want)
			}
		})
	}
}

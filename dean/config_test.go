package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseFollowUpPlatformsAcceptsKnownPlatforms(t *testing.T) {
	got, err := parseFollowUpPlatforms([]string{"messenger", " whatsapp "})
	assert.NoError(t, err)
	assert.Equal(t, []string{"messenger", "whatsapp"}, got)
}

func TestParseFollowUpPlatformsRejectsUnknownPlatformByName(t *testing.T) {
	_, err := parseFollowUpPlatforms([]string{"messenger", "whatsap"})
	assert.Error(t, err)
	assert.Contains(t, err.Error(), `"whatsap"`)
}

func TestParseFollowUpPlatformsRejectsEmptyList(t *testing.T) {
	// env splits an empty variable into a single empty string
	for _, raw := range [][]string{{}, {""}, {" ", ""}} {
		_, err := parseFollowUpPlatforms(raw)
		assert.Error(t, err)
	}
}

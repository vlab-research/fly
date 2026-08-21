package main

import (
	"regexp"
	"strings"
)

func trim(s string) string { return strings.TrimSpace(s) }

// isProd is a heuristic on the DSN, used only to decide how loud the
// confirmation prompt is. A false negative costs a weaker prompt, never a wrong
// write, so it errs toward being cheap rather than exhaustive.
func isProd(dsn string) bool {
	return strings.Contains(dsn, "vprod") || strings.Contains(dsn, "gbv-cockroachdb-public")
}

var passwordInDSN = regexp.MustCompile(`://([^:/@]+):[^@]*@`)

// redactDSN removes a password before the DSN is printed. Pure.
func redactDSN(dsn string) string {
	return passwordInDSN.ReplaceAllString(dsn, "://$1:***@")
}

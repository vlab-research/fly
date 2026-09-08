'use strict';

/*
 * Credential reads, req-free, for the MCP tools.
 *
 * `Credential.getMessagingAccounts` returns the newest row per connected
 * messaging account — `entity`, `key` (which IS the platform account id) and
 * the raw `details` blob, which holds the access token. This function is
 * IO-only and returns those rows untouched; the redaction is a pure function
 * (mcp.core#redactCredential) so it can be tested for leaks without a
 * database. Nothing that leaves the MCP layer may carry `details`.
 */

const { Credential } = require('../../queries');

const listMessagingAccounts = ({ email }) => Credential.getMessagingAccounts({ email });

module.exports = { listMessagingAccounts };

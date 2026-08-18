'use strict';

/**
 * Pure decision layer for credential validation and registry row derivation.
 * No database, no IO, no side effects.
 */

/**
 * Maps a credential entity to the platform it will register as.
 *
 * This mapping is specific to the WRITE PATH: it defines which entity values
 * trigger a messaging_accounts registry row insertion.
 *
 * Note: A single credential can legitimately back multiple platform rows
 * (e.g., Instagram DMs are delivered through a Facebook Page's token), so this
 * map is not a general entity → platform function. It is the write-path default
 * only — querying which accounts a user owns uses a direct registry lookup, not
 * this map.
 *
 * The SendMessageCommand spelling is used here, never the entity spelling.
 *
 * @param {string} entity - The credential entity type
 * @returns {string|null} - The platform string ('messenger', 'whatsapp', etc.) or null if not messaging
 */
function entityToPlatform(entity) {
  const platformMap = {
    'facebook_page': 'messenger',
    'whatsapp_business': 'whatsapp',
  };
  return platformMap[entity] || null;
}

/**
 * Determines whether a credential entity requires a messaging_accounts registry row.
 *
 * @param {string} entity - The credential entity type
 * @returns {boolean} - True if a registry row should be created
 */
function shouldCreateMessagingRegistry(entity) {
  return entityToPlatform(entity) !== null;
}

/**
 * Validates that a messaging credential body is well-formed.
 *
 * Checks that:
 * 1. key is a non-empty string
 * 2. If details.id exists, it matches the key (production invariant)
 *
 * This rejects credentials that would create an invisible account — one that
 * cannot be looked up because the registry row cannot be created.
 *
 * @param {Object} body - The credential creation body
 * @param {string|undefined} body.key - The account ID (required for messaging)
 * @param {Object|undefined} body.details - Optional credential details
 * @param {string|undefined} body.details.id - Optional account ID in details (must match key if present)
 * @returns {{ valid: true } | { valid: false, error: string }}
 */
function validateMessagingCredential(body) {
  const { key, details } = body;

  // Check that key is a non-empty string
  if (!key || typeof key !== 'string' || key.trim() === '') {
    return {
      valid: false,
      error: 'key is required and must be a non-empty string',
    };
  }

  // Production invariant: if details carries an id, it must match the key
  if (details && typeof details === 'object' && details.id !== undefined) {
    if (details.id !== key) {
      return {
        valid: false,
        error: `details.id (${details.id}) must match key (${key})`,
      };
    }
  }

  return { valid: true };
}

module.exports = {
  entityToPlatform,
  shouldCreateMessagingRegistry,
  validateMessagingCredential,
};

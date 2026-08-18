/// <reference types="node" />
//
// Conversation identity for the integration suite.
//
// A conversation is (platform, account_id, user_id) -- not a user id. See
// planning/conversation-identity.md and planning/conversation-identity-test-plan.md.
// Everything in the suite that needs to name a conversation, poll for its
// outbound messages, or read its state row goes through the `Conversation`
// handle defined here rather than passing a bare user id around.

import {
  PAGE_A, PAGE_B, WA_A, WA_B,
  ACCOUNT_PLATFORM, ACCOUNT_OWNER, ACCOUNT_TOKENS,
} from './seed-db';

export type Platform = 'messenger' | 'whatsapp';

export interface Conversation {
  userId: string;
  accountId: string;
  platform: Platform;
}

/**
 * Build a conversation handle for a participant on a given account. The
 * platform is derived from the account rather than passed, because an account
 * id belongs to exactly one platform -- passing both invites them to disagree.
 */
export function conversation(userId: string, accountId: string): Conversation {
  const platform = ACCOUNT_PLATFORM[accountId];
  if (!platform) {
    throw new Error(
      `conversation(): unknown account '${accountId}'. Seeded accounts are: ` +
      Object.keys(ACCOUNT_PLATFORM).join(', ') +
      '. Add it to seed-db.ts rather than hard-coding an id here.',
    );
  }
  return { userId, accountId, platform };
}

/** Convenience constructors for the four seeded accounts. */
export const onPageA = (userId: string): Conversation => conversation(userId, PAGE_A);
export const onPageB = (userId: string): Conversation => conversation(userId, PAGE_B);
export const onWaA = (userId: string): Conversation => conversation(userId, WA_A);
export const onWaB = (userId: string): Conversation => conversation(userId, WA_B);

/** Which researcher owns the account this conversation runs on. */
export const ownerOf = (conv: Conversation): 'A' | 'B' => ACCOUNT_OWNER[conv.accountId];

/** The credential token message-worker will present when sending on this account. */
export const tokenOf = (conv: Conversation): string => ACCOUNT_TOKENS[conv.accountId];

// ---------------------------------------------------------------------------
// The Redis state-cache key.
//
// THE KEY SHAPE IS NOT SETTLED. See planning/conversation-identity-test-plan.md
// §0.9-2. The plan's §7.1 proposes `state:{platform}:{account}:{user}`, but that
// is platform-as-identity, which reverses the ratified (allocator, id) decision
// recorded at documentation/platform-abstraction.md:246-261. If account ids are
// globally unique -- which that model asserts and which
// devops/migrations/20-messaging-account-unique.sql enforces in production today
// -- then `state:{account}:{user}` is sufficient, AND §7.3 (every event carries
// `platform`) stops being a hard prerequisite for §7.1, which materially
// shortens the critical path.
//
// That decision is with the user. Until it lands, every assertion in the suite
// goes through stateKey()/stateKeyGlob() so that flipping it is a one-line
// change here rather than a sweep through the tests.
// ---------------------------------------------------------------------------

export const KEY_INCLUDES_PLATFORM = true;

/** The Redis key replybot should cache this conversation's state under. */
export function stateKey(conv: Conversation): string {
  return KEY_INCLUDES_PLATFORM
    ? `state:${conv.platform}:${conv.accountId}:${conv.userId}`
    : `state:${conv.accountId}:${conv.userId}`;
}

/**
 * A SCAN pattern matching every conversation key belonging to one participant,
 * across all accounts and platforms. This is the shape
 * devops/clear-state-cache.sh must match on after §7.1 (it currently hardcodes
 * the flat `state:<userid>`), and it is what a test uses to count how many
 * conversations a participant holds.
 */
export function stateKeyGlob(userId: string): string {
  return KEY_INCLUDES_PLATFORM ? `state:*:*:${userId}` : `state:*:${userId}`;
}

/** The pre-fix key shape. Tests assert this is NO LONGER used. */
export function legacyStateKey(userId: string): string {
  return `state:${userId}`;
}

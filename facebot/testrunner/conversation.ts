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
// The key is `state:{platform}:{account}:{user}`. Account ids are globally unique
// today, so the platform component is not strictly required -- it is there for the
// case where one account id serves two platforms.
//
// Every assertion in the suite goes through stateKey()/stateKeyGlob(), so changing
// the shape is a one-line change here rather than a sweep through the tests.
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
 * devops/clear-state-cache.sh must match, and what a test uses to count how many
 * conversations a participant holds.
 */
export function stateKeyGlob(userId: string): string {
  return KEY_INCLUDES_PLATFORM ? `state:*:*:${userId}` : `state:*:${userId}`;
}

/** The pre-fix key shape. Tests assert this is NO LONGER used. */
export function legacyStateKey(userId: string): string {
  return `state:${userId}`;
}

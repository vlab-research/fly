import { Pool } from 'pg';
import type { Conversation } from './conversation';

interface Chatbase {
  pool: Pool;
}

interface Response {
  userid: string;
  timestamp: Date;
  [key: string]: any;
}

interface State {
  userid: string;
  [key: string]: any;
}

interface ChatLogEntry {
  userid: string;
  timestamp: Date;
  [key: string]: any;
}

interface Message {
  id: string;
  content: string;
  userid: string;
  timestamp: Date;
  hsh: string;
  account_id?: string;
  platform?: string;
  [key: string]: any;
}

/**
 * Fetch response rows for a participant, optionally scoped by account.
 *
 * When accountId is omitted, returns all responses for the user across all
 * accounts. This is the legacy behavior and is kept for backward compatibility
 * with ~40 existing tests that do not scope by account.
 *
 * When accountId is provided, returns only responses on that account. This is
 * REQUIRED for multi-account tests where one participant holds conversations
 * on multiple accounts — selecting without an account scope is nondeterministic
 * if multiple state rows exist and can mask account-isolation bugs.
 *
 * For ergonomic use with a Conversation handle: call as
 *   getResponses(chatbase, conv.userId, conv.accountId)
 */
export async function getResponses(
  chatbase: Chatbase,
  userid: string,
  accountId?: string,
): Promise<Response[]> {
  let query = 'SELECT * FROM responses WHERE userid=$1';
  const params: (string | undefined)[] = [userid];

  if (accountId !== undefined) {
    query += ' AND pageid=$2';
    params.push(accountId);
  }

  query += ' ORDER BY timestamp ASC';
  const { rows } = await chatbase.pool.query(query, params);
  return rows;
}

/**
 * Fetch a single state row for a participant, optionally scoped by account.
 *
 * When accountId is omitted, returns rows[0] from an unscoped query. This is
 * LEGACY behavior kept for backward compatibility with ~40 existing tests.
 * It is nondeterministic if the participant holds state on more than one
 * account — rows[0] is unpredictable and a test could pass by reading the
 * wrong conversation. Do not use this for new multi-account tests.
 *
 * When accountId is provided, returns the single row for that account. This
 * scoping is REQUIRED for multi-account test isolation — two conversations for
 * one user id on two accounts must not interfere with each other's state
 * assertions. This is the only safe pattern for new tests.
 *
 * For ergonomic use with a Conversation handle: call as
 *   getState(chatbase, conv.userId, conv.accountId)
 */
export async function getState(
  chatbase: Chatbase,
  userid: string,
  accountId?: string,
): Promise<State | undefined> {
  let query = 'SELECT * FROM states WHERE userid=$1';
  const params: (string | undefined)[] = [userid];

  if (accountId !== undefined) {
    query += ' AND pageid=$2';
    params.push(accountId);
  }

  const { rows } = await chatbase.pool.query(query, params);
  return rows[0];
}

/**
 * Fetch ALL state rows for a participant, deterministically ordered by account.
 *
 * Returns every conversation a participant holds across all accounts. The
 * primary use is to assert *how many* conversations exist — tests assert
 * isolation by checking that a participant holds exactly N rows matching N
 * different accounts.
 *
 * Ordered by pageid for determinism across runs.
 */
export async function getAllStates(chatbase: Chatbase, userid: string): Promise<State[]> {
  const { rows } = await chatbase.pool.query(
    'SELECT * FROM states WHERE userid=$1 ORDER BY pageid ASC',
    [userid],
  );
  return rows;
}

/**
 * Fetch chat log entries for a participant, optionally scoped by account.
 *
 * When accountId is omitted, returns all chat log entries for the user across
 * all accounts.
 *
 * When accountId is provided, returns only entries on that account. This
 * scoping is required for multi-account tests to isolate the two conversations'
 * message histories.
 *
 * Ordered by timestamp and direction for determinism.
 *
 * For ergonomic use with a Conversation handle: call as
 *   getChatLog(chatbase, conv.userId, conv.accountId)
 */
export async function getChatLog(
  chatbase: Chatbase,
  userid: string,
  accountId?: string,
): Promise<ChatLogEntry[]> {
  let query = 'SELECT * FROM chat_log WHERE userid=$1';
  const params: (string | undefined)[] = [userid];

  if (accountId !== undefined) {
    query += ' AND pageid=$2';
    params.push(accountId);
  }

  query += ' ORDER BY timestamp ASC, direction ASC';
  const { rows } = await chatbase.pool.query(query, params);
  return rows;
}

/**
 * Fetch message rows for a participant, optionally scoped by account.
 *
 * The unscoped call always works. The SCOPED call deliberately THROWS if
 * `messages.account_id` does not exist yet, rather than filtering in JS and
 * returning []: a silent [] would let "account B's messages must not appear in
 * account A's replay" pass VACUOUSLY, because nothing appears in anything. The
 * error names the missing migration, so a red test reads as "not implemented"
 * rather than "passing".
 *
 * For ergonomic use with a Conversation handle: call as
 *   getMessages(chatbase, conv.userId, conv.accountId)
 */
export async function getMessages(
  chatbase: Chatbase,
  userid: string,
  accountId?: string,
): Promise<Message[]> {
  const { rows } = await chatbase.pool.query(
    'SELECT * FROM messages WHERE userid=$1 ORDER BY timestamp ASC',
    [userid],
  );

  if (accountId === undefined) return rows;

  if (!(await messagesHasAccountColumn(chatbase))) {
    throw new Error(
      'getMessages(): account-scoped read requested but chatroach.messages has no ' +
      'account_id column yet (devops/migrations/26-messages-account.sql has not ' +
      'landed). Refusing to filter in JS and return [], because an empty result ' +
      'would let an isolation assertion pass vacuously. Either apply the migration ' +
      'or call getMessages() unscoped.',
    );
  }

  return rows.filter((row: Message) => row.account_id === accountId);
}

/**
 * Does chatroach.messages carry the account column yet? Cached after the first
 * probe — the schema does not change mid-run.
 */
let _messagesAccountColumn: boolean | undefined;
export async function messagesHasAccountColumn(chatbase: Chatbase): Promise<boolean> {
  if (_messagesAccountColumn !== undefined) return _messagesAccountColumn;
  const { rows } = await chatbase.pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'messages' AND column_name = 'account_id' LIMIT 1`,
  );
  _messagesAccountColumn = rows.length > 0;
  return _messagesAccountColumn;
}

/**
 * Count message rows for a participant.
 *
 * Used as a non-vacuity guard in replay-isolation tests: a test that runs
 * against an empty event log passes trivially and proves nothing. This guard
 * asserts a positive, specific archived-row count before asserting anything
 * about replay behavior, preventing false-positive test passes.
 */
export async function countMessages(chatbase: Chatbase, userid: string): Promise<number> {
  const { rows } = await chatbase.pool.query(
    'SELECT COUNT(*) as count FROM messages WHERE userid=$1',
    [userid],
  );
  return parseInt(rows[0].count, 10);
} 
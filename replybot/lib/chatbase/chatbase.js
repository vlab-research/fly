// Postgres/CockroachDB client for replaying a conversation's archived event log.
// See replybot/README.md ("Archived event log client").
const { Pool } = require('pg');
const { ChatbaseValidationError } = require('./errors');

class Chatbase {
  constructor({ user = process.env.CHATBASE_USER,
    host = process.env.CHATBASE_HOST,
    database = process.env.CHATBASE_DATABASE,
    password = process.env.CHATBASE_PASSWORD,
    port = process.env.CHATBASE_PORT } = {}) {

    if (!port || !host || !database) {
      throw new ChatbaseValidationError(`(database, port, host)
	are strictly required for chatbase-postgres!`);
    }

    this.pool = new Pool({ user, host, database, password, port });

    this.pool.on('error', (err, __client) => { throw err });
  }

  // Read a conversation's archived event log.
  //
  // `conv` is `{ userid, account }`, not a user id. A bare string throws: a caller
  // that forgets to scope must fail loudly rather than quietly interleave two of a
  // participant's conversations. Pass `account: null` explicitly to read across all
  // of them.
  async get(conv, limit) {
    if (typeof conv === 'string' || conv == null) {
      throw new ChatbaseValidationError(
        'chatbase.get() takes ({ userid, account }, limit), not (userid, limit). ' +
        'A conversation is (platform, account_id, user_id) -- reading by user id ' +
        'alone interleaves every account that participant has talked to. ' +
        'If the account is genuinely unknown for this event, pass { userid, account: null } ' +
        'explicitly.'
      );
    }

    const { userid, account } = conv;

    if (userid === undefined || account === undefined) {
      throw new ChatbaseValidationError(
        'chatbase.get() requires both `userid` and `account` keys. Pass ' +
        '`account: null` explicitly to read across all of a participant\'s accounts.'
      );
    }

    // The states subquery must return at most one row, or every message row is
    // duplicated once per row it matches. Scoped: `pageid = $2` against PRIMARY KEY
    // (userid, pageid) gives that for free. Unscoped: aggregate to one row, keeping
    // the old "passes if ANY account's pointer allows it" semantics -- a NULL pointer
    // means that account never truncated, so it must keep admitting everything, and
    // plain min() would ignore NULLs and truncate more than today.
    //
    // Filtering the subquery rather than joining on (userid, account_id) is
    // deliberate: it also keeps the pointer applying to rows whose account_id is
    // still NULL. Under a composite join those match nothing, so every
    // un-backfilled row would get a NULL pointer and bypass truncation entirely.
    //
    // `states.pageid` is the legacy name for the account; the rename is pending.
    //
    // TEMPORARY: `OR account_id IS NULL` admits rows the backfill has not reached.
    // Removing it early makes every un-backfilled conversation replay as EMPTY,
    // because replay reads the OLDEST STATE_STORE_LIMIT events and those are exactly
    // the ones a partial backfill has not touched. Removal gate: the REMOVAL GATE
    // query at the foot of devops/migrations/26-messages-account.sql.
    //
    // SELECT content, not SELECT *: `*` pulls `id`, which lives only in the primary
    // index, and that makes EXPLAIN recommend recreating the index migration 19
    // drops. get() discards everything but `content` anyway.
    const scoped = account !== null;

    const statePointer = scoped
      ? `SELECT userid, message_pointer FROM states WHERE userid = $1 AND pageid = $2`
      : `SELECT userid,
                CASE WHEN bool_or(message_pointer IS NULL) THEN NULL
                     ELSE min(message_pointer) END AS message_pointer
         FROM states WHERE userid = $1 GROUP BY userid`;

    let query = `
      SELECT m.content FROM messages m
      LEFT JOIN (${statePointer}) s USING (userid)
      WHERE m.userid = $1
      ${scoped ? 'AND (m.account_id = $2 OR m.account_id IS NULL)' : ''}
      AND (s.message_pointer IS NULL OR s.message_pointer <= m.timestamp)
      ORDER BY m.timestamp ASC`

    if (limit) {
      query = query + ` limit ${limit}`
    }

    const params = scoped ? [userid, account] : [userid];
    const result = await this.pool.query(query, params);

    return result.rows.map(r => r.content);
  }

  // Put method to insert a new message related to a single user
  async put(key, message, timestamp) {

    const query = `INSERT INTO messages(userid, content, timestamp)
		   values($1, $2, $3)`;

    return this.pool.query(query,
      [key, message, timestamp]);
  }
}

module.exports = Chatbase;

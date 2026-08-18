// The Postgres/CockroachDB client replybot replays a conversation's archived
// event log from (`lib/typewheels/statestore.js` `_getEvents`).
//
// ABSORBED from the `@vlab-research/chatbase-postgres` npm package -- its 0.2.0
// working tree, which was never published -- rather than kept as a dependency,
// because the split was pure cost:
//
//   - There has only ever been ONE backend. The `CHATBASE_BACKEND` env var this
//     used to be loaded through was a pluggable indirection with exactly one
//     implementation; no other `chatbase-*` package was ever written.
//   - Both consumers lived in this repo (replybot's `StateStore`, and
//     facebot/testrunner) and were on DIFFERENT versions, so the integration
//     suite asserted against a four-versions-older client than production ran.
//   - The publish step blocked integration testing outright: the harness builds
//     replybot from its Dockerfile with `npm ci`, so nothing could be tested
//     until a version reached the registry -- and a caret on a `0.x` pins the
//     MINOR, so publishing alone would have silently changed nothing.
//
// See replybot/README.md ("Archived event log client (`lib/chatbase`)").
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
  // A conversation is (platform, account_id, user_id), not a user id. `conv` is
  // therefore an OBJECT, not a string:
  //
  //   get({ userid, account }, limit)
  //
  // `account` must be present. Pass it explicitly as null ONLY when the account
  // genuinely could not be determined from the event -- replybot's
  // StateStore.getState does exactly that, and reading the whole user's log is
  // the right degraded answer there.
  //
  // A bare string first argument THROWS rather than falling back to the old
  // user-keyed read. That is deliberate and is the whole point of changing the
  // shape of the argument instead of appending a parameter: the failure mode of
  // this bug is silence. An un-updated caller must break loudly at the first call
  // rather than quietly keep interleaving two researchers' conversations.
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

    // WHY states IS FILTERED RATHER THAN JOINED ON THE ACCOUNT.
    //
    // The plan's §7.5 says to make this `USING (userid, account_id)`. Filtering
    // the states subquery to the one account and joining on userid alone is
    // better, and does strictly more of what §7.5 wants:
    //
    //   - states is PRIMARY KEY (userid, pageid), so `pageid = $2` selects AT MOST
    //     ONE row. That removes the multi-row duplication (§2.2 item 4) just as a
    //     composite join would -- the duplication came from the subquery returning
    //     one row per account, not from the join key.
    //   - It fixes the message_pointer leak for the same reason: only THIS
    //     account's pointer is in scope, so a form.reset on another account can no
    //     longer satisfy the checkpoint.
    //   - And it keeps the pointer applying to rows whose account_id is still
    //     NULL. Under `USING (userid, account_id)` a NULL account_id matches
    //     nothing, so every un-backfilled row would get a NULL message_pointer and
    //     bypass truncation entirely -- form.reset would silently stop truncating
    //     history until the backfill finished.
    //
    // states.pageid, not states.account_id: the rename to account_id is plan §7.7,
    // deliberately last and cosmetic. messages gets `account_id` (migration 26)
    // while states still says `pageid`, so this alias is load-bearing until §7.7
    // lands -- and when it does, dropping the alias is a rename, not a bug fix.
    //
    // ---------------------------------------------------------------------------
    // `OR account_id IS NULL` IS TEMPORARY -- MIGRATION SCAFFOLDING ONLY.
    //
    // Historical rows predate migration 26 and carry no account until
    // devops/backfill-messages-account.sh has reached them. Including them means
    // an un-backfilled conversation replays exactly as it does today: not better,
    // but not worse, and self-healing as the backfill drains.
    //
    // Excluding them instead (a strict `account_id = $2`) would make every
    // un-backfilled conversation replay as EMPTY -- the "every existing
    // conversation replays as empty" failure the plan warns about, turned from a
    // sequencing risk into a guarantee, because replybot reads the OLDEST
    // STATE_STORE_LIMIT=30000 events and those are precisely the ones a partial
    // backfill has not reached yet.
    //
    // REMOVAL GATE. Delete this branch when the backfill is complete, i.e. when
    // this returns 0 (see devops/migrations/26-messages-account.sql section 4):
    //
    //   SELECT count(*) FROM chatroach.messages
    //    WHERE account_id IS NULL AND json_valid(content)
    //      AND (<devops/sql/messages-account-id-expr.sql>) IS NOT NULL;
    //
    // A plain count of NULL account_id never reaches zero and should not: a small
    // tail of synthetic events carry no account at all and are permanently
    // unattributable.
    // ---------------------------------------------------------------------------
    //
    // SELECT content, not SELECT *. This was an explicit precondition of
    // devops/migrations/19-drop-message-userid-idx.sql that was never shipped:
    // while `SELECT *` remains, EXPLAIN emits an index recommendation to recreate
    // the very index migration 19 drops, because `*` pulls `id`, which lives only
    // in the primary index. get() discards everything but `content` anyway.
    const scoped = account !== null;

    // The states subquery MUST return at most one row, or every message row is
    // duplicated once per row it matches -- which is the other half of §2.2
    // item 4, and it is separately observable as the same event appearing twice
    // in a replay.
    //
    // Scoped: `pageid = $2` against PRIMARY KEY (userid, pageid) gives at most one
    // row for free.
    //
    // Unscoped: there is no account to filter on, so it is aggregated to one row
    // instead. The aggregation reproduces the old "passes if ANY account's pointer
    // allows it" semantics EXACTLY rather than quietly tightening them -- a NULL
    // pointer means that account never truncated, so it must continue to admit
    // everything, and plain min() would ignore NULLs and truncate more than today.
    // This path is the degraded one (account genuinely unknown); it is not the
    // place to change replay semantics, only to stop duplicating rows.
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

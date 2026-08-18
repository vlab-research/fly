// Local CLI tool. Replays one participant's archived event log through the real
// machine and prints the state transition for each event.
//
//   CHATBASE_HOST=... CHATBASE_PORT=... CHATBASE_DATABASE=... \
//   CHATBASE_USER=... CHATBASE_PASSWORD=... node lib/responses/debugger.js <userid>
//
// KEPT DELIBERATELY (§7.1) while `stateman.js`, `scratchbot.js` and `batch.js`
// were deleted: this is the tool for reproducing a cross-conversation state bug
// off the durable log, which is the exact class of bug §7.1 fixes.
//
// It writes to the SAME Redis keys replybot uses, so point it at a scratch Redis
// (or accept that you are refreshing the 24h TTL on real conversation state).
const { StateStore } = require('../typewheels/statestore')
const Chatbase = require('../chatbase/chatbase')
const { PromiseStream } = require('@vlab-research/steez')
const { parseEvent } = require('../event-normalizer')
const { conversationFromRawEvent } = require('../typewheels/utils')
const { DBStream } = require('./pgstream')
const { Machine } = require('../typewheels/transition')

// Keyset pagination on (timestamp, hsh) -- avoids re-scanning and
// re-numbering the user's entire message history on every page (which is
// what the previous ROW_NUMBER()-based pagination did, making this
// effectively unusable for users with many thousands of events). hsh is
// the tiebreaker for messages with identical timestamps; it's already part
// of the table's primary key and the (userid, timestamp ASC) index covers
// this query directly.
async function query(pool, userid, lim) {
  const res = lim
    ? await pool.query(
      `SELECT * FROM messages
       WHERE userid = $1
       AND (timestamp, hsh) > ($2, $3)
       ORDER BY timestamp ASC, hsh ASC
       LIMIT 100;`,
      [userid, lim.timestamp, lim.hsh]
    )
    : await pool.query(
      `SELECT * FROM messages
       WHERE userid = $1
       ORDER BY timestamp ASC, hsh ASC
       LIMIT 100;`,
      [userid]
    )

  const final = res.rows.slice(-1)[0]
  if (!final) return [null, null]
  return [res.rows, { timestamp: final.timestamp, hsh: final.hsh }]
}

const userid = process.argv.slice(2)[0]
if (!userid) throw new Error('GIVE ME USERID!')

const chatbase = new Chatbase()
const emptyBase = { get: () => [], pool: chatbase.pool }
const stateStore = new StateStore(emptyBase)
const machine = new Machine('600s')

const fn = (lim) => query(chatbase.pool, userid, lim)
const stream = new DBStream(fn, null)

stream
  .pipe(new PromiseStream(async ({ userid: userId, content: event }) => {

    // The conversation comes from the event envelope, never from the state --
    // `messages` is not account-scoped yet (§7.4/§7.5), so replaying a user who
    // talked to two accounts interleaves both conversations here. Printing the
    // conversation per event is how you SEE that, which is the point of the tool.
    const conv = conversationFromRawEvent(event)

    const state = await stateStore.getState(conv, userId, event)
    const { newState, output, page, platform } = await machine.transition(state, parseEvent(event))

    console.log('CONVERSATION:\n', { user: userId, ...(conv || { platform: null, account: null }) }, '-----------------------')
    console.log('STATE:\n', state, '-----------------------')
    console.log('EVENT:\n', JSON.parse(event, null, 4), '-----------------------')
    console.log('OUTPUT\n: ', output, '-----------------------')
    console.log('ROUTING:\n', { page, platform }, '-----------------------')
    console.log('NEW STATE:\n', newState, '-----------------------')

    await stateStore.updateState(conv, userId, newState)
  }))

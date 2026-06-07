const { StateStore } = require('../typewheels/statestore')
const Chatbase = require(process.env.CHATBASE_BACKEND)
const { PromiseStream } = require('@vlab-research/steez')
const { parseEvent } = require('@vlab-research/utils')
const { DBStream } = require('./pgstream')
const { TokenStore } = require('../typewheels/tokenstore')
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

const fn = (lim) => query(chatbase.pool, userid, lim)
const stream = new DBStream(fn, null)

const chatbase = new Chatbase()
const emptyBase = { get: () => [], pool: chatbase.pool }
const stateStore = new StateStore(emptyBase)
const tokenStore = new TokenStore(chatbase.pool)
const machine = new Machine('600s', tokenStore)

stream
  .pipe(new PromiseStream(async ({ userid: userId, content: event }) => {

    const state = await stateStore.getState(userId, event)
    const { newState, output } = await machine.transition(state, parseEvent(event))

    // const {actions, pageToken, responses} = await machine.actionsResponses(state, userId, event, page, newState, output)

    console.log('STATE:\n', state, '-----------------------')
    console.log('EVENT:\n', JSON.parse(event, null, 4), '-----------------------')
    console.log('OUTPUT\n: ', output, '-----------------------')
    // console.log('ACTIONS:\n', actions, '-----------------------')
    console.log('NEW STATE:\n', newState, '-----------------------')

    await stateStore.updateState(userId, newState)
  }))

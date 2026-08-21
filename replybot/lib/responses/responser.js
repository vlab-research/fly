const { getField } = require('../typewheels/form')

// This module used to also export a `Responser` class -- a Kafka consumer that
// wrote the `responses` table -- and two entrypoints that ran it
// (`scratchbot.js`, `batch.js`), alongside a sibling `Stateman` consumer
// (`stateman.js`) that wrote `states`. All four are deleted.
//
// They could not have worked since Machine.transition's signature changed to
// (state, parsedEvent): every one of them called
// `machine.transition(state, userId, rawEventString)` with three arguments, so
// `parsedEvent` was the user id string and `parsedEvent.source.account_id` threw
// a TypeError on the first event. Nothing deployed ran them either -- production
// replybot runs only `lib/index.js` (`package.json` `start`), scribble is the
// real writer of both tables, and the `scratchbot` subchart is `false` in every
// environment. They were live only as a source of confusion about who writes
// `states`.
//
// `responseVals` stays: it is pure, it is the actual response-row builder, and
// `typewheels/transition.js` imports it on the live path.
function responseVals(newState, update, form, surveyid, pageid, user, timestamp, platform) {
  if (update) {
    const [q, response] = update
    const shortcode = newState.forms.slice(-1)[0]

    const flowid = newState.forms.length
    const [question_idx, { title: question_text, ref: question_ref }] = getField({ form, user }, q, true)

    const { seed, form: parent_shortcode } = newState.md
    const metadata = newState.md

    return {
      parent_shortcode,
      surveyid,
      shortcode,
      flowid,
      userid: user.id,
      pageid,
      question_ref,
      question_idx,
      question_text,
      response,
      seed,
      metadata,
      timestamp,
      // The conversation's transport ('messenger' | 'whatsapp'). Threaded from
      // the event through transition() -> actionsResponses(); scribble writes
      // it to the nullable `responses.platform` column (migration 26). It is
      // stored on the archival table because `credentials` cascades on user
      // delete, which would otherwise strip the platform binding from history.
      // See planning/conversation-identity.md.
      platform,
    }
  }
}

module.exports = { responseVals }

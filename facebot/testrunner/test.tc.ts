/// <reference types="node" />
import 'chai';
import parallel from 'mocha.parallel';
import sendMessage from './sender';
import { makeQR, makePostback, makeTextResponse, makeReferral, makeSynthetic, getFields, fieldsFromForm, makeNotify, makeEcho, makeHandover, makeWhatsAppReferral, makeWhatsAppText, makeWhatsAppReply, makeWhatsAppTextStart, Field } from './mox';
import { v4 as uuid } from 'uuid';
import farmhash from 'farmhash';
import {
  seed,
  LEGACY_ATTACHMENT_ID,
  MESSENGER_PLATFORM_MEDIA_ID,
  WHATSAPP_PLATFORM_MEDIA_ID,
  MEDIA_URL_NO_HANDLE,
  THIRD_PARTY_MEDIA_URL,
  PAGE_A,
  PAGE_B,
  WA_A,
  WA_B,
  ACCOUNT_TOKENS,
  ACCOUNT_PLATFORM,
} from './seed-db';
import { flowMaster, flowMasterWhatsApp, TestFlow, ErrorResponse, SuccessResponse, receiveSent, receiveSentEnvelope, registerAccounts } from './socket';
import { snooze, waitFor } from './utils';
import { getResponses, getState, getAllStates, getChatLog, getMessages, countMessages, messagesHasAccountColumn } from './responses';
import { onPageA, onPageB, onWaA, onWaB, stateKey, stateKeyGlob, legacyStateKey } from './conversation';
import { makeReferralFor, makeTextResponseFor, makeQRFor, makeEchoFor, makeSyntheticRaw } from './mox';
import Redis from 'ioredis';
import { startStack, stopStack, consumeTopic, topicEndOffsets, Stack } from './stack';
import type { StartedTestContainer } from 'testcontainers';
import { triggerDean } from './dean-trigger';
import { Pool } from 'pg';
import mustache from 'mustache';
import fs from 'fs';
import path from 'path';

///////////////////////////////////////////////
// SETUP -----------------------------------
let stack: Stack;
let chatbase: { pool: Pool };

interface Message {
  text: string;
  metadata: string;
}

function makeRepeat(field: Field, text: string): Message {
  const ref = JSON.parse(field.metadata || '{}').ref;
  return {
    text: text,
    metadata: JSON.stringify({ repeat: true, ref })
  };
}

function makeRepeated(field: Field): Field {
  return { ...field, metadata: JSON.stringify({ isRepeat: true, ...JSON.parse(field.metadata || '{}') }) };
}

interface OffMessage {
  message: {
    text: string;
  };
  metadata: {
    ref: string;
  };
}

function makeOff(): OffMessage {
  return {
    message: {
      text: "We're sorry, but this survey is now over and closed."
    },
    metadata: {
      ref: 'off_message'
    }
  };
}

// The referral ref that triggers replybot's RESET branch (machine.js, REFERRAL).
// Must match REPLYBOT_RESET_SHORTCODE, which stack.ts injects into the replybot
// container -- see the note there for why the harness had to start setting it.
// Kept identical to the staging/production value.
const RESET_SHORTCODE = 'reset';

const ok: SuccessResponse = { res: 'success' };
const err: ErrorResponse = { error: { message: 'test error', code: 555 } };
const err2: ErrorResponse = { error: { message: 'test error', code: -1 } };

function interpolate(str: string, values: Record<string, string>): string {
  return mustache.parse(str)
    .map((token: any[]) => {
      const [type, value] = token;
      return type === 'name' ? values[value] : value;
    })
    .join('');
}

const get = { text: 'get message' }; // Define get message

// Receive one outbound Messenger payload, ack it, and echo it back into the
// pipeline — exactly what flowMaster does per interaction, minus the equality
// assertion, so a test can assert the FULL POST body (which flowMaster hides,
// since it only ever compares data.message) and still drive the conversation.
//
// Every message a form produces MUST be consumed this way. The stack runs
// message-worker with NUM_WORKERS=1, so a single un-acked send blocks the only
// worker goroutine for facebot's full 10s timeout — which starves every other
// test in the same mocha.parallel block, not just the one that left the mess.
async function receiveAndEcho(userId: string): Promise<any> {
  const sent = await receiveSent(userId);
  await sendMessage(makeEcho({
    metadata: sent.message?.metadata,
    text: sent.message?.text,
  } as Field, userId));
  return sent;
}

// Print everything a human needs to actually inspect a held stack: the docker
// names to `docker logs`, and the host-mapped endpoints to query directly.
//
// Without this KEEP_STACK is only half a debugging tool -- the containers are up,
// but they carry testcontainers' random names and randomly-mapped ports, so
// finding the right one is a `docker ps | grep` guessing game every time.
function printStackHandles(s: Stack): void {
  const containers: [string, StartedTestContainer][] = [
    ['cockroach', s.cockroach],
    ['redpanda', s.redpanda],
    ['redis', s.redis],
    ['scribble-states', s.scribbleStates],
    ['scribble-responses', s.scribbleResponses],
    ['scribble-messages', s.scribbleMessages],
    ['scribble-chat-log', s.scribbleChatlLog],
    ['formcentral', s.formcentral],
    ['dinersclub', s.dinersclub],
    ['botserver (hermes)', s.botserver],
    ['replybot', s.replybot],
    ['message-worker', s.messageWorker],
    ['facebot', s.facebot],
  ];

  console.log('\n' + '='.repeat(72));
  console.log('KEEP_STACK is set -- the stack is HELD. Press Ctrl-C to tear it down.');
  // Mocha runs root `after` hooks BEFORE it emits the run-end event, and the
  // reporter's epilogue (the "N passing / N failing" counts and the failure stack
  // traces) is printed on that event. So while the stack is held you have the
  // per-test ✓/✗ lines above but NOT the summary. Say so, rather than let someone
  // conclude the run died.
  console.log('The per-test results above are complete; the summary and failure');
  console.log('stack traces print after you Ctrl-C (mocha prints its epilogue after');
  console.log('root hooks return).');
  console.log('='.repeat(72));
  for (const [label, c] of containers) {
    console.log(`  ${label.padEnd(20)} docker logs -f ${c.getName().replace(/^\//, '')}`);
  }
  console.log('');
  console.log(`  cockroach   psql '${s.chatbaseConnString}'`);
  console.log(`  redis       redis-cli -u ${s.redisUrl}`);
  console.log(`  facebot     ${s.facebotUrl}`);
  console.log(`  botserver   ${s.botserverUrl}`);
  console.log('='.repeat(72) + '\n');
}

///////////////////////////////////////////////
// TESTS -----------------------------------
describe('Test Bot flow Survey Integration Testing', () => {

  before(async function() {
    this.timeout(900000); // image builds take time on first run
    stack = await startStack();
    process.env.FACEBOT_URL = stack.facebotUrl;
    process.env.BOTSERVER_URL = stack.botserverUrl;
    const pool = new Pool({ connectionString: stack.chatbaseConnString });
    chatbase = { pool };
    await seed(chatbase);

    // Tell the facebot mock which credential token belongs to which account.
    // Needed only by the conversation-isolation tests, and harmless for
    // everything else: an unregistered token still resolves to accountId null,
    // and the legacy GET /sent/:userId route is untouched.
    //
    // This registration is what makes an outbound MESSENGER send attributable at
    // all -- the page id appears nowhere in /me/messages, only in the bearer
    // token (message-worker/messenger_client.go:96-103).
    await registerAccounts(
      Object.entries(ACCOUNT_TOKENS).map(([accountId, token]) => ({
        token,
        accountId,
        platform: ACCOUNT_PLATFORM[accountId],
      })),
    );

    console.log('Test starting!');
  });

  after(async function() {
    this.timeout(60000);

    // KEEP_STACK: hold the containers up so a human can inspect them.
    //
    // This is the workflow the README documents for debugging this suite, and it
    // did not work. Mocha applies the hook timeout to HOOKS as well as tests, so
    // the old `await new Promise(() => {})` was killed at 60s, reported as an
    // EXTRA FAILURE on top of whatever was being debugged, and `--exit` then tore
    // the stack down anyway -- the exact opposite of what was asked for, with no
    // explanation left behind. Three things fix it:
    //
    //   1. this.timeout(0) -- no hook timeout, so holding is not a failure.
    //      Mechanically: mocha 6's Runnable#timeout(0) sets `_enableTimeouts =
    //      false` (runnable.js). It does NOT clear the already-armed 60s timer --
    //      but that timer's own callback re-checks `_enableTimeouts` and returns
    //      without failing the hook, so the effect is the same. Don't "tidy" this
    //      into a later this.timeout(60000): `_enableTimeouts` is sticky-false, so
    //      such a call sets `_timeout` and arms nothing. It would read as a
    //      restored guard while being a no-op.
    //   2. `--exit` never fires, because mocha only exits once the run COMPLETES
    //      and this hook has not returned. The process staying alive is also what
    //      keeps the containers alive: testcontainers' Ryuk reaper removes them
    //      when the session's connection drops, i.e. when this process dies. So
    //      "hold the process" and "hold the stack" are the same thing.
    //   3. AN EXPLICIT KEEP-ALIVE TIMER. An awaited promise does NOT keep node
    //      running, and neither do the signal listeners below -- node unrefs its
    //      signal handles, so a process whose only remaining "work" is a pending
    //      promise plus `process.once('SIGINT', ...)` exits IMMEDIATELY, code 0,
    //      silently. Verified directly. This was the second half of the bug and it
    //      is the one that survives fixing the first: with only (1) and (2) the
    //      stack held for ~2 minutes -- exactly as long as testcontainers' own
    //      residual sockets and timers kept the loop referenced -- and then
    //      vanished with no message. A ref'd interval is what actually holds it.
    //
    // Ctrl-C (or SIGTERM) releases the hook and falls through to a NORMAL
    // teardown, rather than leaving orphaned containers behind.
    if (process.env.KEEP_STACK && stack) {
      this.timeout(0);
      printStackHandles(stack);
      // ~12.4 days; the point is only that it is a REF'D handle. See note (3).
      const keepAlive = setInterval(() => { /* hold the event loop */ }, 1 << 30);
      await new Promise<void>((resolve) => {
        const release = (sig: string) => {
          console.log(`\n[KEEP_STACK] ${sig} received -- tearing the stack down.`);
          clearInterval(keepAlive);
          resolve();
        };
        process.once('SIGINT', () => release('SIGINT'));
        process.once('SIGTERM', () => release('SIGTERM'));
      });
    }

    if (chatbase?.pool) await chatbase.pool.end();
    if (stack) await stopStack(stack);
    console.log('Test finished!');
  });

  parallel('Basic Functionality', function () {
    this.timeout(45000);

    it('Recieves bailout event and switches forms', async () => {
      const userId = uuid();
      const fieldsA = getFields('forms/v7R942.json');
      const fieldsB = getFields('forms/BhaV5G.json');
      const err: ErrorResponse = { error: { message: 'test error', code: 555 } };

      const testFlow: TestFlow = [
        [err, fieldsA[0], [makeSynthetic(userId, { type: 'bailout', value: { form: 'BhaV5G' } })]],
        [ok, fieldsB[0], []],
        [ok, fieldsB[1], []],
      ];

      await sendMessage(makeReferral(userId, 'v7R942'));
      await flowMaster(userId, testFlow);
    });

    it('Follows logic jumps based on external events: payment success', async () => {
      const userId = uuid();
      const fields = getFields('forms/SNomCIYT.json');

      const testFlow: TestFlow = [
        [ok, fields[0], [makeTextResponse(userId, '+918888000000')]],
        [ok, fields[1], [makeQR(fields[1], userId, 0)]],
        [ok, fields[2], []],
        [ok, fields[5], []],
      ];

      await sendMessage(makeReferral(userId, 'SNomCIYT'));
      await flowMaster(userId, testFlow);
    });

    it('Follows logic jumps based on external events: payment failure', async () => {
      const userId = uuid();
      const vals = { 'hidden:e_payment_fake_error_message': 'you fake' };
      const form = fs.readFileSync('forms/gk3gt9ag.json', 'utf-8');
      const fields = fieldsFromForm(JSON.parse(interpolate(form, vals)));

      const testFlow: TestFlow = [
        [ok, fields[0], [makeTextResponse(userId, '+918888000000')]],
        [ok, fields[1], [makeQR(fields[1], userId, 0)]],
        [ok, fields[2], []],
        [ok, fields[3], []],
        [ok, fields[4], [makeEcho(get, userId)]],
        [ok, fields[0], []],
      ];

      await sendMessage(makeReferral(userId, 'gk3gt9ag'));
      await flowMaster(userId, testFlow);
    });

    it('Interpolates hidden fields into message text at runtime', async () => {
      // Unlike the 'payment failure' test above, this does NOT pre-substitute
      // the {{hidden:...}} placeholder into the form JSON before parsing. The
      // value is delivered the same way the absolute-timeout test proves it
      // flows: via referral extra segments (getMetadata's ref-splitting), so
      // replybot's real interpolateField/getFromMetadata engine renders the
      // message text at runtime. A missing hidden field renders as an empty
      // string (never an error) per replybot/HANDOFF_PROTOCOL.md.
      const userId = uuid();
      const fields = getFields('forms/hiddenInterp.json');

      const testFlow: TestFlow = [
        [ok, { ...fields[0], text: 'Hello Nandan, welcome!' }, []],
        [ok, { ...fields[1], text: 'Your code is:' }, []],
        [ok, fields[2], []],
      ];

      await sendMessage(makeReferral(userId, 'hiddenInterp.greeting_name.Nandan'));
      await flowMaster(userId, testFlow);
    });

    it('Resumes survey after handover, interpolating flattened e_handover_metadata_*', async () => {
      const userId = uuid();
      const ECHO = '976665718578167';   // previous owner (echo app) → e_handover_target_app_id
      const FLY = '111222333';          // new owner (return leg); any value — FACEBOOK_APP_ID unset so guard bypassed
      const fields = getFields('forms/handoffTest.json');

      await sendMessage(makeReferral(userId, 'handoffTest'));
      await flowMaster(userId, [
        [ok, fields[0], [makeTextResponse(userId, 'hi')]],   // answer q0 → bot sends handoff statement
        [ok, fields[1], []],                                 // handoff statement; flowMaster auto-echo arms the wait + fires HANDOFF
      ]);

      // wait until the handoff wait is armed before the external app returns control
      await waitFor(async () => {
        const s = await getState(chatbase, userId);
        return s?.current_state === 'WAIT_EXTERNAL_EVENT' ? s : null;
      }, 30000);

      // external app returns thread control with metadata (mirrors smoke-echo's { smoke_echo:'ok', echo_text:<text> })
      await sendMessage(makeHandover(userId, FLY, ECHO, { echo_text: 'hi', smoke_echo: 'ok' }));

      // survey resumes; field[2] rendered with flattened handover metadata
      await flowMaster(userId, [
        [ok, { ...fields[2], text: 'Echo said: hi (status ok)' }, []],
        [ok, fields[3], []],
      ]);
    });

    [0, 1].forEach(idx => {
      it(`Test chat flow with logic jump idx ${idx}`, async () => {
        const userId = uuid();
        const fields = getFields('forms/LDfNCy.json');
        const testFlow: TestFlow = [
          [ok, fields[0], [makePostback(fields[0], userId, 0)]],
          [ok, fields[1], [makePostback(fields[1], userId, idx)]],
          [ok, fields[3], []],
          [ok, fields[5], []],
        ];

        await sendMessage(makeReferral(userId, 'LDfNCy'));
        await flowMaster(userId, testFlow);
      });
    });

    it('Puts user into blocked state when given facebook error', async () => {
      const userId = uuid();
      const fields = getFields('forms/LDfNCy.json');
      const err: ErrorResponse = { error: { message: 'test error', code: 555 } };

      const testFlow: TestFlow = [
        [err, fields[0], []]
      ];

      await sendMessage(makeReferral(userId, 'LDfNCy'));
      await flowMaster(userId, testFlow);

      const state = await waitFor(async () => {
        const s = await getState(chatbase, userId);
        return s?.current_state !== 'RESPONDING' ? s : null;
      });
      state.current_state.should.equal('BLOCKED');
      state.fb_error_code.should.equal('555');
    });

    it('Puts user into error state when given a bad form', async () => {
      const userId = uuid();
      await sendMessage(makeReferral(userId, 'DOESNTEXIST'));

      const state = await waitFor(async () => {
        const s = await getState(chatbase, userId);
        return s?.current_state !== 'RESPONDING' ? s : null;
      });
      state.current_state.should.equal('ERROR');

      // The thin-error contract: states.error carries ONLY tag/code/message/ts.
      // The rich context -- formcentral's response body, the HTTP status, the
      // stack -- stays on the machine_report event in `messages` and is
      // deliberately not duplicated onto the hot states row. `messages` is the
      // durable log; states.error is a live-state projection of it.
      // See documentation/error-events.md and replybot/README.md.
      const error = state.state_json.error;
      error.tag.should.equal('FORM_NOT_FOUND');
      error.message.should.include('DOESNTEXIST');

      // ts is the onset of the error episode -- the triggering event's
      // timestamp -- which is what the errored_at computed column exposes.
      error.ts.should.be.a('number');

      // Nothing outside the whitelist may leak back onto the states row.
      Object.keys(error).forEach((k: string) => {
        ['tag', 'code', 'message', 'ts'].should.include(k);
      });
      error.should.not.have.property('status');
      error.should.not.have.property('stack');
    });

    it('Test chat flow with logic jump from previous question', async () => {
      const userId = uuid();
      const fields = getFields('forms/jISElk.json');

      const testFlow: TestFlow = [
        [ok, fields[0], [makeQR(fields[0], userId, 1)]],
        [ok, fields[1], [makeQR(fields[1], userId, 5)]],
        [ok, fields[2], [makeTextResponse(userId, 'LOL')]],
        [ok, fields[4], []],
        [ok, fields[5], []],
      ];

      await sendMessage(makeReferral(userId, 'jISElk'));
      await flowMaster(userId, testFlow);
    });

    ['red', 'blue'].forEach((color, idx) => {
      it(`Test chat flow with choice-condition logic jump: ${color}`, async () => {
        const userId = uuid();
        const fields = getFields('forms/choiceJump.json');
        const target = color === 'red' ? fields[1] : fields[2];

        const testFlow: TestFlow = [
          [ok, fields[0], [makeQR(fields[0], userId, idx)]],
          [ok, target, []],
          [ok, fields[3], []],
          [ok, fields[4], []],
        ];

        await sendMessage(makeReferral(userId, 'choiceJump'));
        await flowMaster(userId, testFlow);
      });
    });

    it('Test chat flow with webview field (keepMoving, no user input required)', async () => {
      const userId = uuid();
      const fields = getFields('forms/webviewTest.json');

      const testFlow: TestFlow = [
        [ok, fields[0], []],
        [ok, fields[1], []],
        [ok, fields[2], []],
      ];

      await sendMessage(makeReferral(userId, 'webviewTest'));
      await flowMaster(userId, testFlow);
    });

    // RED (TDD, expected to fail against the current message-worker):
    // replybot correctly carries a field's `sendParams` through to
    // `command.message.metadata.sendParams` (locked at the replybot layer by
    // `replybot/lib/typewheels/transition.test.js`), but the Go worker's
    // `FacebookSendRequest` (message-worker/messenger_client.go) only has
    // `{Recipient, Message}` — there is no top-level `messaging_type`/`tag`
    // anywhere in the worker, so sendParams never reaches the outbound
    // Facebook Send API payload. Message tags are in active production use
    // (97 forms / 3,078 participants, last 3-6mo) — this is a real gap, not
    // a deprecated path. This test will go green once the worker forwards
    // `metadata.sendParams` onto the top level of the POST body it sends to
    // facebot. We use `receiveSent` (not `flowMaster`/`getFields`) because
    // both of those only ever look at `data.message`, stripping the very
    // top-level `messaging_type`/`tag` fields this test asserts on.
    it('Forwards message-tag sendParams to messaging_type/tag on the outbound Facebook payload [RED: worker drops sendParams]', async () => {
      const userId = uuid();

      await sendMessage(makeReferral(userId, 'tagTest'));
      const sent = await receiveSent(userId);

      sent.messaging_type.should.equal('MESSAGE_TAG');
      sent.tag.should.equal('CONFIRMED_EVENT_UPDATE');
    });

    // RED (TDD, expected to fail against the current message-worker):
    // utility_message templates are the go-forward re-contact mechanism
    // (Meta's "UTILITY" category, the only out-of-24hr-window send path FB
    // currently allows) and have never been exercised through V2.
    // `replybot/lib/generic-translator.js`'s `translateUtilityMessage` emits
    // a plain `question` message (template/language/params tucked into
    // `metadata`, with `metadata.type === 'utility_message'`), but the Go
    // worker's `translateMessengerQuestion` (message-worker/translator.go)
    // never inspects `metadata.type` the way `translateMessengerText` does
    // for webview/notify/notification_messages — it just renders Options as
    // plain quick_replies and never sets `messaging_type`. So today this
    // field is sent as an ordinary text-with-quick-replies message, not a
    // UTILITY template. This test will go green once the worker gains a
    // utility_message translator that emits `messaging_type: 'UTILITY'` and
    // a `message.template` with body/buttons components as below.
    it('Sends utility_message fields as a Facebook UTILITY template message [RED: worker has no utility_message translator]', async () => {
      const userId = uuid();

      await sendMessage(makeReferral(userId, 'utilityTest'));
      const sent = await receiveSent(userId);

      sent.messaging_type.should.equal('UTILITY');
      sent.message.template.name.should.equal('recontact_test');
      sent.message.template.language.code.should.equal('en_US');

      const components = sent.message.template.components;
      components[0].type.should.equal('body');
      components[0].parameters[0].should.eql({ type: 'text', text: '₦1,000' });

      // One choice on forms/utilityTest.json -> exactly one buttons component,
      // whose POSTBACK payload is the field's own ref (not the choice's ref) —
      // see scripts/test-utility-send.js's `candidate` variant, which repeats
      // the field ref once per button inside a single `buttons` component.
      const buttonsComponent = components.find((c: any) => c.type === 'buttons');
      buttonsComponent.parameters.should.eql([{ type: 'POSTBACK', payload: 'utilityField' }]);
    });

    it('Test chat flow logic jump from hidden seed_2 field', async () => {
      const fields = getFields('forms/nFgfNE.json');

      const makeId = (): string => {
        const uid = uuid();
        const suitable = farmhash.fingerprint32('nFgfNE' + uid) % 2 === 0;
        return suitable ? uid : makeId();
      };

      const userId = makeId();

      const testFlow: TestFlow = [
        [ok, fields[0], [makeQR(fields[0], userId, 1)]],
        [ok, fields[1], [makePostback(fields[1], userId, 0)]],
        [ok, fields[3], []],
      ];

      await sendMessage(makeReferral(userId, 'nFgfNE'));
      await flowMaster(userId, testFlow);
    });

    it('Test chat flow with validation failures', async () => {
      const userId = uuid();
      const fields = getFields('forms/ciX4qo.json');

      const repeatPhone = makeRepeat(fields[0], 'Sorry, please enter a valid phone number.');
      const repeatEmail = makeRepeat(fields[1], 'Sorry, please enter a valid email address.');

      const testFlow: TestFlow = [
        [ok, fields[0], [makeTextResponse(userId, '23345')]],
        [ok, repeatPhone, []],
        [ok, makeRepeated(fields[0]), [makeTextResponse(userId, '+918888000000')]],
        [ok, fields[1], [makeTextResponse(userId, 'foo')]],
        [ok, repeatEmail, []],
        [ok, makeRepeated(fields[1]), [makeTextResponse(userId, 'foo@gmail.com')]],
        [ok, fields[2], []]
      ];

      await sendMessage(makeReferral(userId, 'ciX4qo'));
      await flowMaster(userId, testFlow);
    });

    it('Test chat flow with custom validation error messages', async () => {
      // This test only needs to prove that a custom repeat-message *text* is
      // substituted on validation failure; the full two-field round trip is
      // redundant with the 'validation failures' (ciX4qo) test above.
      const userId = uuid();
      const fields = getFields('forms/KAvzEUWn.json');

      const repeatNumber = makeRepeat(fields[0], 'foo number bar');

      const testFlow: TestFlow = [
        [ok, fields[0], [makeTextResponse(userId, 'haha not number')]],
        [ok, repeatNumber, []],
        [ok, makeRepeated(fields[0]), [makeTextResponse(userId, '590')]],
        [ok, fields[1], []],
      ];

      await sendMessage(makeReferral(userId, 'KAvzEUWn'));
      await flowMaster(userId, testFlow);
    });

    it('Test chat flow with stitched forms: stitches and maintains seed', async () => {
      const makeId = (): string => {
        const uid = uuid();
        const suitable = farmhash.fingerprint32('Llu24B' + uid) % 5 === 0;
        return suitable ? uid : makeId();
      };

      const userId = makeId();
      const fieldsA = getFields('forms/Llu24B.json');
      const fieldsB = getFields('forms/tKG55U.json');

      const testFlow: TestFlow = [
        [ok, fieldsA[0], [makeTextResponse(userId, 'LOL')]],
        [ok, fieldsA[1], []],
        [ok, fieldsB[0], [makePostback(fieldsB[0], userId, 0)]],
        [ok, fieldsB[2], []],
      ];

      await sendMessage(makeReferral(userId, 'Llu24B'));
      await flowMaster(userId, testFlow);

      const res = await waitFor(async () => {
        const r = await getResponses(chatbase, userId);
        return r.length >= 2 ? r : null;
      }, 30000);
      res.length.should.equal(2);
      res.map(r => r['response']).should.include('LOL');
      res.map(r => r['response']).should.include('Yes');
      res.map(r => r['parent_shortcode']).should.eql(['Llu24B', 'Llu24B']);
    });

    it('Test chat flow with stitched forms, does not allow first form to be retaken', async () => {
      const makeId = (): string => {
        const uid = uuid();
        const suitable = farmhash.fingerprint32('Llu24B' + uid) % 5 === 0;
        return suitable ? uid : makeId();
      };

      const userId = makeId();
      const fieldsA = getFields('forms/Llu24B.json');
      const fieldsB = getFields('forms/tKG55U.json');

      // Re-referral to the already-taken first form MID-FLOW (while awaiting the
      // answer to form B's first question) must not reopen it; the bot repeats
      // the retake-block message. NOTE: this only holds mid-flow — a re-referral
      // after the survey has completed does not emit this message.
      const testFlow: TestFlow = [
        [ok, fieldsA[0], [makeTextResponse(userId, 'LOL')]],
        [ok, fieldsA[1], []],
        [ok, fieldsB[0], [makeReferral(userId, 'Llu24B')]],
        [ok, makeRepeat(fieldsB[0], "Sorry, that answer is not valid. Please try to answer the question again."), []],
      ];

      await sendMessage(makeReferral(userId, 'Llu24B'));
      await flowMaster(userId, testFlow);
    });

    it('Test chat flow - does not allow retaking of forms even after switching', async () => {
      const userId = uuid();
      const fieldsA = getFields('forms/LDfNCy.json');
      const fieldsB = getFields('forms/tKG55U.json');

      const testFlow: TestFlow = [
        [ok, fieldsA[0], [makePostback(fieldsA[0], userId, 0)]],
        [ok, fieldsA[1], [makeReferral(userId, 'tKG55U')]],
        [ok, fieldsB[0], [makeReferral(userId, 'LDfNCy')]],
        [ok, makeRepeat(fieldsB[0], "Sorry, that answer is not valid. Please try to answer the question again."), []],
      ];

      await sendMessage(makeReferral(userId, 'LDfNCy'));
      await flowMaster(userId, testFlow);
    });

    it('Test chat flow on forms with translated responses', async () => {
      const userId = uuid();
      const [source, dest] = ['hc2slBXH', 'mzs7qmvZ'];

      const query = `update surveys set translation_conf = jsonb_set(translation_conf, ARRAY['destination'], to_json((select id from surveys where shortcode = $1 limit 1)::STRING)) where shortcode = $2;`;

      await chatbase.pool.query(query, [dest, source]);

      const fields = getFields('forms/hc2slBXH.json');

      const testFlow: TestFlow = [
        [ok, fields[0], [makeQR(fields[0], userId, 0)]],
        [ok, fields[1], [makeTextResponse(userId, 'LOL')]],
        [ok, fields[2], []],
      ];

      await sendMessage(makeReferral(userId, 'hc2slBXH'));
      await flowMaster(userId, testFlow);

      const res = await waitFor(async () => {
        const r = await getResponses(chatbase, userId);
        return r.length >= 2 ? r : null;
      }, 30000);
      res.length.should.equal(2);
      res.map(r => r['response']).should.include('LOL');
      res.map(r => r['response']).should.include('Good');
      res.map(r => r['translated_response']).should.include('LOL');
      res.map(r => r['translated_response']).should.include('Bien');
    });

    it('Test chat flow with multiple links and keepMoving tag', async () => {
      const userId = uuid();
      const fields = getFields('forms/B6cIAn.json');

      const testFlow: TestFlow = [
        [ok, fields[0], []],
        [ok, fields[1], []],
        [ok, fields[2], []]
      ];

      await sendMessage(makeReferral(userId, 'B6cIAn'));
      await flowMaster(userId, testFlow);
    });

    it('Multi-part attachment question sends both the image and the multiple-choice', async () => {
      const userId = uuid();
      const fields = getFields('forms/multi-part-attachment.json');

      const testFlow: TestFlow = [
        [ok, fields[0], []],
        [ok, fields[1], [makeQR(fields[1], userId, 0)]],
        [ok, fields[2], []]
      ];

      await sendMessage(makeReferral(userId, 'multi-part-attachment'));
      await flowMaster(userId, testFlow);
    });

    ///////////////////////////////////////////////
    // MEDIA RESOLUTION (planning/media-abstraction.md §8.3, §10 section 4)
    //
    // These assert the SHAPE of the attachment payload that reached facebot —
    // which key is present and, just as importantly, which is absent — because
    // `attachment_id` and `url` are both `omitempty` on
    // types.AttachmentPayload. Asserting only "a message arrived" would pass
    // with the resolver disabled entirely and would therefore prove nothing.
    //
    // They live in `Basic Functionality` because they are ordinary Messenger
    // send-path tests: each uses its own uuid user, reads only seeded rows and
    // never triggers dean, so it satisfies the one constraint mocha.parallel
    // imposes here. The serial blocks exist for dean/QOUT ordering
    // (documentation/testing.md, "Cross-cutting harness gotchas"), which none
    // of this touches.
    //
    // Each media form ends in an unanswered multiple_choice, which is where the
    // conversation stops. Every test below therefore drains BOTH messages the
    // form produces (see receiveAndEcho): leaving the trailing question un-acked
    // costs facebot's 10s send timeout on the stack's single worker goroutine
    // and cascades into unrelated failures across this whole parallel block.

    // Rule 1 (§8.3): a legacy `media_attachment_id` is passed through
    // byte-for-byte and never resolved. §11.1's production audit found this
    // path carries ~100% of live media traffic, so this is the regression that
    // matters most. `is_reusable` and `url` belong only to the URL form; their
    // presence would mean the legacy branch had been rerouted.
    it('Legacy Messenger attachment_id is sent untouched, with no url or is_reusable', async () => {
      const userId = uuid();

      await sendMessage(makeReferral(userId, 'mediaLegacyId'));
      const sent = await receiveAndEcho(userId);

      sent.message.attachment.type.should.equal('image');
      const payload = sent.message.attachment.payload;
      payload.should.have.property('attachment_id', LEGACY_ATTACHMENT_ID);
      payload.should.not.have.property('url');
      payload.should.not.have.property('is_reusable');

      await receiveAndEcho(userId); // drain the terminal question
    });

    // Rule 2, hit: the asset URL parses, the handle row exists for THIS page id,
    // so the send carries the seeded platform_media_id rather than the URL.
    it('Asset URL with a live Messenger handle sends by attachment_id, not by url', async () => {
      const userId = uuid();

      await sendMessage(makeReferral(userId, 'mediaAssetHandle'));
      const sent = await receiveAndEcho(userId);

      const payload = sent.message.attachment.payload;
      payload.should.have.property('attachment_id', MESSENGER_PLATFORM_MEDIA_ID);
      payload.should.not.have.property('url');
      payload.should.not.have.property('is_reusable');

      await receiveAndEcho(userId); // drain the terminal question
    });

    // Rule 2, miss: an asset of ours with no handle row on any account. The
    // handle layer is an optimisation, never a requirement — a miss degrades to
    // a URL send rather than failing the message (§13).
    it('Asset URL with no handle degrades to a url send', async () => {
      const userId = uuid();

      await sendMessage(makeReferral(userId, 'mediaAssetNoHandle'));
      const sent = await receiveAndEcho(userId);

      const payload = sent.message.attachment.payload;
      payload.should.have.property('url', MEDIA_URL_NO_HANDLE);
      payload.should.have.property('is_reusable', true);
      payload.should.not.have.property('attachment_id');

      await receiveAndEcho(userId); // drain the terminal question
    });

    // A third-party URL is deliberately out of scope (§2, "Third-party URLs are
    // out of scope"): it fails ParseAssetID, so no lookup happens at all and it
    // is sent exactly as it is today. This is the no-regression pin for authors
    // who paste imgur links.
    it('Third-party URL is always sent by url, never resolved', async () => {
      const userId = uuid();

      await sendMessage(makeReferral(userId, 'mediaThirdParty'));
      const sent = await receiveAndEcho(userId);

      const payload = sent.message.attachment.payload;
      payload.should.have.property('url', THIRD_PARTY_MEDIA_URL);
      payload.should.have.property('is_reusable', true);
      payload.should.not.have.property('attachment_id');

      await receiveAndEcho(userId); // drain the terminal question
    });

    // HANDLE REUSE — the single most important case here (§10 section 4).
    // The worker resolves per command, so a handle that worked once must work
    // every time. Without this, every send in the suite could be a silent URL
    // fallback and everything would still pass green. The echo between the two
    // sends is built from the metadata facebot actually received, so it does not
    // depend on the JS translator agreeing with the Go one.
    it('Sending the same asset twice in one flow sends by attachment_id both times', async () => {
      const userId = uuid();

      await sendMessage(makeReferral(userId, 'mediaHandleReuse'));

      const first = await receiveAndEcho(userId);
      first.message.attachment.payload.should.have.property('attachment_id', MESSENGER_PLATFORM_MEDIA_ID);
      first.message.attachment.payload.should.not.have.property('url');

      const second = await receiveAndEcho(userId);
      second.message.attachment.payload.should.have.property('attachment_id', MESSENGER_PLATFORM_MEDIA_ID);
      second.message.attachment.payload.should.not.have.property('url');

      // Distinct fields, so this really is a second resolution and not the same
      // message observed twice.
      JSON.parse(second.message.metadata).ref
        .should.not.equal(JSON.parse(first.message.metadata).ref);

      await receiveAndEcho(userId); // drain the terminal question
    });

    it('Waits for external event and continues after event', async () => {
      const userId = uuid();
      const fields = getFields('forms/Ep5wnS.json');

      const testFlow: TestFlow = [
        [ok, fields[0], [makePostback(fields[0], userId, 0)]],
        [ok, fields[1], [makeSynthetic(userId, { type: 'external', value: { type: 'moviehouse:play', id: 164118668 } })]],
        [ok, fields[2], [makePostback(fields[2], userId, 0)]],
        [ok, fields[3], []]
      ];

      await sendMessage(makeReferral(userId, 'Ep5wnS'));
      await flowMaster(userId, testFlow);
    });

    it('Works with multiple or clauses - india endline seed_16 bug', async () => {
      const fields = getFields('forms/UGqDwc.json');

      const makeId = (): string => {
        const uid = uuid();
        const suitable = farmhash.fingerprint32('UGqDwc' + uid) % 16 === 3;
        return suitable ? uid : makeId();
      };

      const userId = makeId();

      const testFlow: TestFlow = [
        [ok, fields[0], [makeQR(fields[0], userId, 0)]],
        [ok, fields[1], []],
        [ok, fields[2], []],
        [ok, fields[3], []],
        [ok, fields[4], []],
        [ok, fields[5], []],
        [ok, fields[6], []],
        [ok, fields[22], []],
        [ok, fields[23], []],
        [ok, fields[24], []]
      ];

      await sendMessage(makeReferral(userId, 'UGqDwc'));
      await flowMaster(userId, testFlow);
    });
  });

  describe('Timeouts', function () {
    this.timeout(60000);

    it('Sends timeout message response when interrupted in a timeout, then waits', async function() {
      this.timeout(60000);
      const userId = uuid();
      const fields = getFields('forms/vHXzrh.json');

      await sendMessage(makeReferral(userId, 'vHXzrh'));
      await flowMaster(userId, [
        [ok, fields[0], [makeTextResponse(userId, 'LOL')]],
        [ok, { text: 'Please wait!', metadata: '{"repeat":true,"ref":"bd2b2376-d722-4b51-8e1e-c2000ce6ec55"}' }, []],
        [ok, makeRepeated(fields[0]), []],
      ]);
      await waitFor(async () => {
        const s = await getState(chatbase, userId);
        return s?.current_state === 'WAIT_EXTERNAL_EVENT' ? s : null;
      }, 30000);
      await snooze(2000);
      await triggerDean(stack.network, stack.deanImage, stack.deanEnv, 'timeouts');
      await snooze(5000);
      await flowMaster(userId, [
        [ok, fields[1], [makeTextResponse(userId, 'LOL')]],
        [ok, fields[2], []],
      ]);
    });

    it('Sends message after timeout absolute timeout', async function() {
      this.timeout(60000);

      const userId = uuid();
      const timeoutDate = (new Date(Math.floor(Date.now() / 1000 - 5) * 1000)).toISOString();

      const vals = { 'hidden:timeout_date': timeoutDate };
      const form = fs.readFileSync('forms/j1sp7ffL.json', 'utf-8');
      const fields = fieldsFromForm(JSON.parse(interpolate(form, vals)));

      await sendMessage(makeReferral(userId, `j1sp7ffL.timeout_date.${timeoutDate}`));
      // Receive first message, respond with nothing (enters waiting/timeout state)
      await flowMaster(userId, [
        [ok, fields[0], []],
      ]);
      await waitFor(async () => {
        const s = await getState(chatbase, userId);
        return s?.current_state === 'WAIT_EXTERNAL_EVENT' ? s : null;
      }, 30000);
      // Dean fires the timeout
      await triggerDean(stack.network, stack.deanImage, stack.deanEnv, 'timeouts');
      await snooze(5000);
      // Bot sends the timeout-triggered message
      await flowMaster(userId, [
        [ok, fields[1], [makeTextResponse(userId, 'loved it')]],
        [ok, fields[2], []],
      ]);
    });

    it('Sends messages with notify token after timeout', async function() {
      this.timeout(60000);

      const userId = uuid();
      const fields = getFields('forms/dbFwhd.json');

      await sendMessage(makeReferral(userId, 'dbFwhd'));
      await flowMaster(userId, [
        [ok, fields[0], [makeNotify(userId, '{ "ref": "908088b3-5e9e-4b53-b746-799ac51bc758"}')]],
      ]);
      await flowMaster(userId, [
        [ok, fields[1], []],
        [ok, fields[2], [makePostback(fields[2], userId, 1)]],
        [ok, fields[3], []],
      ]);
      await waitFor(async () => {
        const s = await getState(chatbase, userId);
        return s?.current_state === 'WAIT_EXTERNAL_EVENT' ? s : null;
      }, 30000);
      await snooze(2000);
      await triggerDean(stack.network, stack.deanImage, stack.deanEnv, 'timeouts');
      await snooze(5000);
      await flowMaster(userId, [
        [ok, fields[4], [makeQR(fields[4], userId, 1)], 'FOOBAR'],
        [ok, fields[5], []],
      ]);
    });

    it('Sends follow ups when the user does not respond', async function() {
      this.timeout(60000);

      const userId = uuid();
      const fields = getFields('forms/ulrtpfSQ.json');

      const followUp = makeRepeat(fields[0], 'this is a follow up');

      await sendMessage(makeReferral(userId, 'ulrtpfSQ'));
      await flowMaster(userId, [
        [ok, fields[0], []],
      ]);
      // Dean's followups query only matches current_state = 'QOUT'; waiting for
      // just any state row races the scribble upsert and dean finds 0 users.
      await waitFor(async () => {
        const s = await getState(chatbase, userId);
        return s?.current_state === 'QOUT' ? s : null;
      }, 30000);
      await triggerDean(stack.network, stack.deanImage, stack.deanEnv, 'followups');
      await snooze(5000);
      // Bot sends the followup message and continues
      await flowMaster(userId, [
        [ok, followUp, []],
        [ok, makeRepeated(fields[0]), [makeQR(fields[0], userId, 0)]],
        [ok, fields[1], []],
      ]);
    });

    it('Retries sending the message when it fails with a proper code', async function() {
      this.timeout(60000);

      const userId = uuid();
      const fields = getFields('forms/LDfNCy.json');
      const errRetry: ErrorResponse = { error: { message: 'test error', code: -1 } };

      // Delivery error with retryable code blocks the user
      await sendMessage(makeReferral(userId, 'LDfNCy'));
      await flowMaster(userId, [
        [errRetry, fields[0], []],
      ]);
      // Give Kafka time to propagate BLOCKED state
      await snooze(3000);
      const state = await waitFor(async () => {
        const s = await getState(chatbase, userId);
        return s?.current_state !== 'RESPONDING' ? s : null;
      }, 30000);
      state.current_state.should.equal('BLOCKED');
      state.fb_error_code.should.equal('-1');
    });
  });

  describe('Phone normalization via e164 transform', function () {
    this.timeout(60000);

    it('Normalizes messy phone input and sends clean E.164 to payment provider', async () => {
      const userId = uuid();
      const fields = getFields('forms/phoneE164.json');

      const testFlow: TestFlow = [
        [ok, fields[0], [makeTextResponse(userId, '+918888000000 use this')]],
        [ok, fields[1], []],
        [ok, fields[2], []],
      ];

      await sendMessage(makeReferral(userId, 'phoneE164'));
      await flowMaster(userId, testFlow);

      const state = await waitFor(async () => {
        const s = await getState(chatbase, userId);
        return s?.current_state === 'END' ? s : null;
      }, 30000);

      state.state_json.md.e_payment_fake_phone.should.equal('+918888000000');
      state.state_json.md.e_payment_fake_success.should.equal(true);
    });
  });

  // End-to-end WhatsApp coverage: inbound events enter via Hermes' /whatsapp
  // handler (source:'whatsapp'), the replybot normalizes them to UniversalEvents
  // and drives the SAME platform-agnostic state machine, and outbound messages
  // go out through the real message-worker WhatsApp client to the facebot mock's
  // /{phone_number_id}/messages endpoint. Because WhatsApp has no native message
  // echo, the worker emits the bot_echo that advances the conversation.
  parallel('WhatsApp E2E', function () {
    this.timeout(60000);

    it('Processes a WhatsApp text answer and advances the survey', async () => {
      const userId = 'wa_' + uuid();
      const fields = getFields('forms/KAvzEUWn.json');

      await sendMessage(makeWhatsAppReferral(userId, 'KAvzEUWn'));
      await flowMasterWhatsApp(userId, [
        [ok, fields[0], [makeWhatsAppText(userId, '590')]],
        [ok, fields[1], []],
      ]);
    });

    it('Starts survey via bare-text form ref (wa.me link entry point)', async () => {
      const userId = 'wa_' + uuid();
      const fields = getFields('forms/KAvzEUWn.json');

      await sendMessage(makeWhatsAppTextStart(userId, 'KAvzEUWn'));
      await flowMasterWhatsApp(userId, [
        [ok, fields[0], [makeWhatsAppText(userId, '590')]],
        [ok, fields[1], []],
      ]);
    });

    // webview arrives from replybot as a platform-agnostic `text` message with
    // the destination tucked in metadata.url, so a translator that dispatches
    // only on MessageContent.Type sends the prose and silently drops the link —
    // which is exactly what WhatsApp did until translateWhatsAppWebview existed
    // (the survey then waits forever on a moviehouse event the user can never
    // trigger). Assert the cta_url envelope itself, not just the body text:
    // flowMasterWhatsApp compares interactive.body.text and would pass on a
    // plain-text send that carries no button at all.
    it('Sends a webview field as a cta_url button carrying the url', async () => {
      const userId = 'wa_' + uuid();

      await sendMessage(makeWhatsAppReferral(userId, 'webviewTest'));

      await receiveSent(userId);            // introStatement
      await snooze(1000);                   // let the worker echo advance state
      const sent = await receiveSent(userId); // webviewField

      sent.type.should.equal('interactive');
      sent.interactive.type.should.equal('cta_url');
      sent.interactive.body.text.should.equal('Check out our website!');
      sent.interactive.action.name.should.equal('cta_url');
      sent.interactive.action.parameters.display_text.should.equal('Open Website');
      sent.interactive.action.parameters.url.should.equal('https://example.com/survey-extra');

      // CONSUME EVERY MESSAGE THE FORM PRODUCES. `keepMoving: true` makes the
      // webview field auto-advance, so webviewTest.json emits a THIRD send -- the
      // thankyou screen -- and this test used to walk away from it. The Messenger
      // twin ('Test chat flow with webview field') consumes all three; only the
      // WhatsApp one stopped at two.
      //
      // MEASURED COST of leaving it: the message-worker log showed a 12.1s stall
      // with SIX WhatsApp commands queued behind the un-acked send, because the
      // stack pins NUM_WORKERS=1 and facebot's send timeout is 10s. That did not
      // fail anything (~14s against a 45s timeout), but it starves every other test
      // in this `parallel` block for the duration and makes every timing
      // measurement in it noisier -- exactly the failure mode the README warns
      // about, where the symptom appears as unrelated timeouts elsewhere.
      const thankyou = await receiveSent(userId);
      thankyou.type.should.equal('text');
      thankyou.text.body.should.equal('Done! Your information was sent perfectly.');
    });

    // MEDIA RESOLUTION on WhatsApp (§10 section 4, case 5). types.WhatsAppMedia
    // has `omitempty` on BOTH `link` and `id`, so exactly one must be present
    // and the other absent — a payload carrying both, or neither, is something
    // the Cloud API would reject and that an "a message arrived" assertion would
    // miss entirely. These live in the WhatsApp block for the same reason every
    // other WhatsApp send-shape test does: the outbound envelope is a different
    // shape, and the flow is advanced by the worker's own bot_echo rather than
    // by an echo the test sends.
    it('WhatsApp asset URL with a live handle sends {id} and no {link}', async () => {
      const userId = 'wa_' + uuid();

      await sendMessage(makeWhatsAppReferral(userId, 'mediaAssetHandleWa'));
      const sent = await receiveSent(userId);

      sent.type.should.equal('image');
      sent.image.should.have.property('id', WHATSAPP_PLATFORM_MEDIA_ID);
      sent.image.should.not.have.property('link');

      // Drain the terminal question. On WhatsApp the worker emits the bot_echo
      // itself, so the next message arrives whether or not this test wants it;
      // leaving it un-acked burns facebot's 10s timeout on the single worker.
      await snooze(1000);
      await receiveSent(userId);
    });

    it('WhatsApp asset URL with no handle sends {link} and no {id}', async () => {
      const userId = 'wa_' + uuid();

      await sendMessage(makeWhatsAppReferral(userId, 'mediaAssetNoHandle'));
      const sent = await receiveSent(userId);

      sent.type.should.equal('image');
      sent.image.should.have.property('link', MEDIA_URL_NO_HANDLE);
      sent.image.should.not.have.property('id');

      await snooze(1000);
      await receiveSent(userId); // drain the terminal question
    });

    ['red', 'blue'].forEach((color, idx) => {
      it(`Follows a WhatsApp interactive choice logic jump: ${color}`, async () => {
        const userId = 'wa_' + uuid();
        const fields = getFields('forms/choiceJump.json');
        const target = color === 'red' ? fields[1] : fields[2];

        await sendMessage(makeWhatsAppReferral(userId, 'choiceJump'));
        await flowMasterWhatsApp(userId, [
          [ok, fields[0], [makeWhatsAppReply(fields[0], userId, idx)]],
          [ok, target, []],
          [ok, fields[3], []],
          [ok, fields[4], []],
        ]);
      });
    });
  });

  // =========================================================================
  // CONVERSATION IDENTITY  --  planning/conversation-identity-test-plan.md §B
  //
  // A conversation is (platform, account_id, user_id). Replybot keys it by user
  // id alone (replybot/lib/typewheels/statestore.js:64-66), so one participant
  // messaging two of a researcher's accounts SHARES ONE STATE BLOB. That kills
  // conversations with FIELD_NOT_FOUND and writes one researcher's participant
  // data into another researcher's account scope.
  //
  // SERIAL, NOT mocha.parallel. Every test here drives two conversations for one
  // user id and asserts on shared Redis and DB state. Under mocha.parallel, with
  // message-worker pinned to NUM_WORKERS=1, interleaved two-account flows make
  // failures unattributable -- one un-drained send starves every neighbour for
  // facebot's full 10s timeout and surfaces as unrelated 45s timeouts.
  //
  // ALL OF THESE ARE RED UNTIL §7.1 LANDS (which itself waits on §7.3). That is
  // the point: per §C.3 of the plan they are regressions on silent data loss, and
  // a test that was never seen red proves nothing about a bug whose signature is
  // the ABSENCE of a row. Each test records its observed pre-fix failure.
  // =========================================================================
  describe('Conversation identity: (platform, account_id, user_id)', function () {
    this.timeout(120000);

    let redis: Redis;

    // Narrow away `undefined` AND fail with a useful message. A bare non-null
    // assertion would turn "the row this test is about does not exist" into an
    // opaque TypeError several lines later.
    function must<T>(v: T | undefined | null, what: string): T {
      if (v === undefined || v === null) {
        throw new Error(`expected ${what} to exist, got ${String(v)}`);
      }
      return v;
    }

    before(async () => {
      redis = new Redis(stack.redisUrl);
    });

    after(async () => {
      if (redis) await redis.quit();
    });

    // Count the cache keys a participant holds, across all accounts. SCAN, not
    // KEYS -- the same discipline devops/clear-state-cache.sh must adopt after
    // §7.1, since that script runs against production Redis where KEYS stalls.
    async function scanKeys(pattern: string): Promise<string[]> {
      const found: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        found.push(...batch);
      } while (cursor !== '0');
      return found.sort();
    }

    // Force a cache miss for one conversation, whatever key shape is live.
    //
    // Deletes BOTH the post-fix tuple key and the pre-fix flat key. That is
    // deliberate: it makes the §B8 tests exercise REPLAY SCOPING rather than key
    // shape, which B1 and B10 already cover. If these tests only deleted the
    // tuple key they would fail pre-fix at the delete (returning 0) and never
    // reach the replay assertions at all -- red for a trivial reason, and blind
    // to the bug they exist to catch.
    //
    // Pre-fix the flat key is shared, so deleting it evicts both conversations;
    // that is inherent to the bug, not a flaw in the test.
    //
    // Returns keys removed. Callers assert this is > 0: a replay test that never
    // actually forced a miss proves nothing.
    async function forceCacheMiss(...convs: { userId: string; accountId: string; platform: 'messenger' | 'whatsapp' }[]): Promise<number> {
      const keys = new Set<string>();
      for (const c of convs) {
        keys.add(stateKey(c));
        keys.add(legacyStateKey(c.userId));
      }
      return await redis.del(...Array.from(keys));
    }

    // Did replybot log a FIELD_NOT_FOUND while this test ran? The live 2026-08-16
    // reproduction failed exactly this way -- form.js:185 raising on a field ref
    // that belongs to the OTHER account's form -- and the resulting ERROR state
    // is terminal, because FIELD_NOT_FOUND is not in DEAN_ERROR_TAGS so no sweep
    // ever retries it.
    async function replybotLogsSince(marker: number): Promise<string> {
      const stream: any = await stack.replybot.logs({ since: marker });
      return await new Promise((resolve) => {
        let buf = '';
        stream.on('data', (c: Buffer) => { buf += c.toString(); });
        stream.on('end', () => resolve(buf));
        setTimeout(() => resolve(buf), 2500);
      });
    }

    // ---------------------------------------------------------------- B1-1
    // Two Messenger pages, two researchers, one participant, two forms.
    //
    // OBSERVED PRE-FIX FAILURE: getAllStates returns 1 row, not 2 -- the second
    // conversation OVERWRITES the first at the same cache key, and only one
    // states row is ever written. scanKeys(state:*:*:<user>) returns 0, because
    // the only key present is the flat legacy `state:<user>`.
    it('B1-1 [RED until §7.1]: two Messenger pages, same user, progress independently', async () => {
      const userId = uuid();
      const convA = onPageA(userId);
      const convB = onPageB(userId);
      const fieldsA = getFields('forms/isoFormA.json');
      const fieldsB = getFields('forms/isoFormB.json');

      // Entry on both accounts. Researcher A owns isoFormA; researcher B owns
      // isoFormB, and isoFormB is deliberately NOT seeded under researcher A --
      // so a leak cannot resolve to a form the other account can serve.
      await sendMessage(makeReferralFor(convA, 'isoFormA'));
      await flowMaster(convA, [[ok, fieldsA[0], []]]);

      await sendMessage(makeReferralFor(convB, 'isoFormB'));
      await flowMaster(convB, [[ok, fieldsB[0], []]]);

      // Strictly interleaved answers, each through its own account-scoped driver.
      await sendMessage(makeTextResponseFor(convA, 'blue'));
      await flowMaster(convA, [[ok, fieldsA[1], []]]);

      await sendMessage(makeQRFor(fieldsB[0], convB, 0));
      await flowMaster(convB, [[ok, fieldsB[1], []]]);

      // TWO conversations, not one. This count is the crispest statement of the
      // isolation property.
      const states = await waitFor(async () => {
        const s = await getAllStates(chatbase, userId);
        return s.length === 2 ? s : null;
      }, 30000);
      states.length.should.equal(2);

      const rowA = must(states.find((s: any) => s.pageid === PAGE_A), `states row on page A (${PAGE_A})`);
      const rowB = must(states.find((s: any) => s.pageid === PAGE_B), `states row on page B (${PAGE_B})`);

      // Each row is on its OWN form, and its md names its OWN account. md.pageid
      // is one of the two fields that bleed, so assert it explicitly.
      rowA.state_json.forms.slice(-1)[0].should.equal('isoFormA');
      rowB.state_json.forms.slice(-1)[0].should.equal('isoFormB');
      rowA.state_json.md.pageid.should.equal(PAGE_A);
      rowB.state_json.md.pageid.should.equal(PAGE_B);

      // Neither conversation observed the other's answers.
      JSON.stringify(rowA.state_json.qa).should.not.include('isob_');
      JSON.stringify(rowB.state_json.qa).should.not.include('isoa_');

      // Two distinct cache keys, and the flat legacy key is gone.
      const keys = await scanKeys(stateKeyGlob(userId));
      keys.length.should.equal(2);
      keys.should.include(stateKey(convA));
      keys.should.include(stateKey(convB));
      ((await redis.exists(legacyStateKey(userId))) === 0).should.equal(true);
    });

    // ---------------------------------------------------------------- B1-2
    // THE SHARPEST REGRESSION TEST. `wa_id` is the participant's phone number
    // and is IDENTICAL across every business number they message, so this fails
    // 100% of the time pre-fix -- whereas the Messenger case (B1-1) depends on
    // PSID reuse across pages. If only one isolation test can be maintained,
    // keep this one.
    //
    // OBSERVED PRE-FIX FAILURE: same as B1-1 -- one states row, one flat key.
    it('B1-2 [RED until §7.1]: two WhatsApp numbers, same wa_id, progress independently', async () => {
      const userId = '1541' + Math.floor(Math.random() * 1e6);
      const convA = onWaA(userId);
      const convB = onWaB(userId);
      const fieldsA = getFields('forms/isoFormA.json');
      const fieldsB = getFields('forms/isoFormB.json');

      await sendMessage(makeReferralFor(convA, 'isoFormA'));
      await flowMasterWhatsApp(convA, [[ok, fieldsA[0], []]]);

      await sendMessage(makeReferralFor(convB, 'isoFormB'));
      await flowMasterWhatsApp(convB, [[ok, fieldsB[0], []]]);

      await sendMessage(makeTextResponseFor(convA, 'blue'));
      await flowMasterWhatsApp(convA, [[ok, fieldsA[1], []]]);

      const states = await waitFor(async () => {
        const s = await getAllStates(chatbase, userId);
        return s.length === 2 ? s : null;
      }, 30000);
      states.length.should.equal(2);

      const rowA = must(states.find((s: any) => s.pageid === WA_A), `states row on WA number A (${WA_A})`);
      const rowB = must(states.find((s: any) => s.pageid === WA_B), `states row on WA number B (${WA_B})`);
      rowA.state_json.forms.slice(-1)[0].should.equal('isoFormA');
      rowB.state_json.forms.slice(-1)[0].should.equal('isoFormB');
      rowA.platform.should.equal('whatsapp');
      rowB.platform.should.equal('whatsapp');

      const keys = await scanKeys(stateKeyGlob(userId));
      keys.length.should.equal(2);
    });

    // ---------------------------------------------------------------- B1-3
    // Cross-platform: a Messenger page and a WhatsApp number, one user id.
    //
    // CONTRIVED BY CONSTRUCTION -- a real participant cannot share an identifier
    // across Messenger and WhatsApp. It is here because it is the ONLY test that
    // proves `platform` is a live component of the cache key rather than dead
    // weight, which is exactly what the settled full-triple key shape asserts.
    it('B1-3 [RED until §7.1]: same user id on Messenger and WhatsApp are distinct conversations', async () => {
      const userId = '1' + Math.floor(Math.random() * 1e11);
      const convM = onPageA(userId);
      const convW = onWaB(userId);
      const fieldsA = getFields('forms/isoFormA.json');
      const fieldsB = getFields('forms/isoFormB.json');

      await sendMessage(makeReferralFor(convM, 'isoFormA'));
      await flowMaster(convM, [[ok, fieldsA[0], []]]);

      await sendMessage(makeReferralFor(convW, 'isoFormB'));
      await flowMasterWhatsApp(convW, [[ok, fieldsB[0], []]]);

      const states = await waitFor(async () => {
        const s = await getAllStates(chatbase, userId);
        return s.length === 2 ? s : null;
      }, 30000);

      const m = must(states.find((s: any) => s.pageid === PAGE_A), 'Messenger states row');
      const w = must(states.find((s: any) => s.pageid === WA_B), 'WhatsApp states row');

      // Asserting `states.platform` literally is safe HERE and only here: these are
      // FRESH conversations driven through the live harness, and replybot persists
      // md.platform at conversation start, so the computed column is non-NULL.
      //
      // Do NOT copy this assertion into anything that reads historical rows. In
      // production `states.platform` is NULL for the overwhelming majority of rows
      // -- 3,820 of the 3,831 multi-account rows -- because it is computed from
      // state_json->'md'->>'platform' and predates that field being persisted.
      // COALESCE(platform, 'messenger') is correct today but is an INFERENCE, not an
      // observation. A check written as `platform = 'messenger'` matches 6 rows in
      // production, not 3,826. See finding (12a) in the test plan.
      m.platform.should.equal('messenger');
      w.platform.should.equal('whatsapp');

      const keys = await scanKeys(stateKeyGlob(userId));
      keys.length.should.equal(2);
      keys.should.include(stateKey(convM));
      keys.should.include(stateKey(convW));
    });

    // ---------------------------------------------------------------- B1-4
    // The Kafka key must STAY the user id.
    //
    // This is a non-regression test, not a bug test -- it passes today and must
    // keep passing. Both of a participant's conversations are produced under the
    // same key, so they land on one partition and are processed in strict order by
    // one replybot spine. That is WHY the bug is a deterministic
    // last-writer-wins rather than a race, and why the two-account tests above are
    // reproducible rather than flaky. §7.1 changes the STATE key; if anyone
    // "helpfully" also changes the PARTITION key, ordering guarantees the rest of
    // the system leans on break silently.
    //
    // Consumed from inside the docker network via rpk -- see consumeTopic().
    it('B1-4: both conversations are produced to chat-events under the same user-id key', async () => {
      const userId = uuid();
      const convA = onPageA(userId);
      const convB = onPageB(userId);
      const fieldsA = getFields('forms/isoFormA.json');
      const fieldsB = getFields('forms/isoFormB.json');

      // Bookmark the topic BEFORE driving anything, and read only what follows.
      //
      // This used to read the OLDEST 500 records of `chat-events`. It passed while
      // the suite was small and then broke on nothing but growth: the topic reached
      // a high watermark of 556, this test runs near the end of the suite, and its
      // own events therefore fell outside the window -- so `mine` was empty and the
      // test died as a bare 120s mocha timeout naming nothing. A bookmark makes the
      // read proportional to what THIS test produced, so it stays correct however
      // large the suite gets. See consumeTopic() in stack.ts.
      const since = await topicEndOffsets(stack, 'chat-events');

      await sendMessage(makeReferralFor(convA, 'isoFormA'));
      await flowMaster(convA, [[ok, fieldsA[0], []]]);
      await sendMessage(makeReferralFor(convB, 'isoFormB'));
      await flowMaster(convB, [[ok, fieldsB[0], []]]);

      const records = await consumeTopic(stack, 'chat-events', { from: since });
      const mine = records.filter(r => r.key === userId);

      // Both accounts' events are present...
      mine.length.should.be.greaterThan(1);
      // ...and EVERY one of them is keyed on the participant, not the account.
      mine.forEach(r => { (r.key as string).should.equal(userId); });
      records.filter(r => r.key === PAGE_A).length.should.equal(0);
      records.filter(r => r.key === PAGE_B).length.should.equal(0);
    });

    // ---------------------------------------------------------------- B2-1
    // *** THE REGRESSION TEST FOR THE WHOLE BUG. *** The §1.1 reproduction,
    // verbatim: entry on account A poisons a LIVE conversation on account B.
    //
    // OBSERVED PRE-FIX FAILURE (this is the live 2026-08-16 production failure,
    // reproduced in the harness): the button press on account B is validated
    // against the form-A field the cached state left behind, so form.js:185
    // raises
    //     FIELD_NOT_FOUND: Could not find the requested field, isoa_*, in our
    //     form: isoFormB
    // the conversation goes to ERROR and STAYS there -- FIELD_NOT_FOUND is not in
    // DEAN_ERROR_TAGS (NETWORK,INTERNAL,STATE_ACTIONS) so no sweep retries it,
    // and every touch refreshes the 24h TTL so the corrupt state is served
    // forever. Only devops/clear-state-cache.sh recovers the participant.
    //
    // Run in BOTH directions so the test cannot accidentally depend on write
    // ordering.
    [
      { name: 'A poisons B', live: 'B', entry: 'A' },
      { name: 'B poisons A', live: 'A', entry: 'B' },
    ].forEach(({ name, live, entry }) => {
      it(`B2-1 [RED until §7.1]: §1.1 reproduction -- ${name}`, async () => {
        const userId = uuid();
        const liveConv = live === 'B' ? onPageB(userId) : onPageA(userId);
        const entryConv = entry === 'A' ? onPageA(userId) : onPageB(userId);
        const liveForm = live === 'B' ? 'isoFormB' : 'isoFormA';
        const entryForm = entry === 'A' ? 'isoFormA' : 'isoFormB';
        const liveFields = getFields(`forms/${liveForm}.json`);
        const entryFields = getFields(`forms/${entryForm}.json`);

        const marker = Math.floor(Date.now() / 1000);

        // Any failure in this test is a statement about what replybot did with a
        // shared state blob, so dump its log on the way out. Without this the
        // failure is "no message arrived", which says nothing about WHY.
        try {
          await runRepro();
        } catch (e) {
          const logs = await replybotLogsSince(marker);
          const relevant = logs
            .split('\n')
            .filter((l) => /STATE:|REPORT:|FIELD_NOT_FOUND|Error|error|ERROR/.test(l))
            .slice(-25)
            .join('\n');
          console.log(`\n===== replybot log during ${name} =====\n${relevant}\n=====\n`);
          throw e;
        }
        return;

        // eslint-disable-next-line no-unreachable
        async function runRepro() {
        // 1. A live conversation on the "live" account, parked on its first
        //    question. isoFormB's first field is a multiple_choice, so there is
        //    a button to press in step 3.
        await sendMessage(makeReferralFor(liveConv, liveForm));
        await flowMaster(liveConv, [[ok, liveFields[0], []]]);

        // 2. A fresh entry on the OTHER account. This is the write that poisons
        //    state:<userId> today.
        await sendMessage(makeReferralFor(entryConv, entryForm));
        await flowMaster(entryConv, [[ok, entryFields[0], []]]);

        // 3. The participant answers in the LIVE conversation.
        const answer = liveForm === 'isoFormB'
          ? makeQRFor(liveFields[0], liveConv, 0)
          : makeTextResponseFor(liveConv, 'blue');
        await sendMessage(answer);

        // ASSERTION 1 (FIRST, deliberately): the two conversations have not MERGED.
        //
        // Ordered ahead of everything else because pre-fix the corruption happens
        // IMMEDIATELY on processing this answer, whereas every assertion below is
        // downstream of a reply that never arrives -- so later, the test would die
        // on a receive() timeout and the actual signature would never print.
        //
        // OBSERVED PRE-FIX (captured 2026-08-17, this test, real stack):
        //   newState.forms = ["isoFormB","isoFormA"]   <- BOTH researchers' forms
        //   newState.qa    = [["isoa_q1","Excellent"]] <- form A's field ref holding
        //                                                 form B's choice label
        //   newState.md    = { form:"isoFormA", pageid:"935593143497601" }
        //   ...while the event arrived on 811223344556677, so:
        //   FORM_NOT_FOUND: Survey with shortcode isoFormA ... for page
        //   811223344556677 could not be found.   (ourform.js:42)
        //   -> state ERROR, terminal.
        //
        // Note the signature is FORM_NOT_FOUND here, not the FIELD_NOT_FOUND of the
        // live §1.1 incident. Same mechanism, one step earlier: this fixture puts
        // the two forms under DIFFERENT researchers (required by B3), so the form
        // lookup 404s before the machine ever reaches the field lookup. Neither tag
        // is in DEAN_ERROR_TAGS (NETWORK,INTERNAL,STATE_ACTIONS), so both are
        // equally terminal -- no sweep retries either, and the cached state
        // outlives every deploy. Assert on both.
        await snooze(4000);
        const earlyLogs = await replybotLogsSince(marker);
        const hits = earlyLogs
          .split('\n')
          .filter((l) => /FIELD_NOT_FOUND|FORM_NOT_FOUND/.test(l));
        if (hits.length > 0) {
          throw new Error(
            `Terminal form/field error raised on the ${liveConv.accountId} conversation ` +
            `after a state write from ${entryConv.accountId} -- this is the §1.1 bug. ` +
            `First ${Math.min(hits.length, 2)} of ${hits.length} line(s):\n` +
            hits.slice(0, 2).join('\n'),
          );
        }

        // The sharpest deterministic assertion available: the live conversation's
        // form stack must contain ONLY its own form. A merged stack is the bug in
        // its purest observable form, independent of which error tag fires.
        const mid = await getState(chatbase, userId, liveConv.accountId);
        if (mid && mid.state_json && mid.state_json.forms) {
          mid.state_json.forms.should.eql([liveForm]);
        }

        // ASSERTION 2: the reply is the live form's NEXT question -- not an
        // error, not a field from the other researcher's form.
        const envelope = await receiveSentEnvelope(liveConv);
        envelope.data.message.text.should.equal(liveFields[1].text);

        // ASSERTION 3: it went out on the account the event arrived on. On
        // Messenger this is only observable via the bearer token, which is why
        // seed-db gives each account a distinct one.
        envelope.accountId.should.equal(liveConv.accountId);

        // Echo the send back, ON THIS CONVERSATION'S ACCOUNT. receiveSentEnvelope
        // acks but does not echo, and on Messenger it is the echo that advances
        // the machine off RESPONDING. Without it the state assertion below would
        // time out waiting for a transition that can never happen -- a misleading
        // failure that looks nothing like the bug under test.
        await sendMessage(makeEchoFor(
          { metadata: envelope.data.message?.metadata, text: envelope.data.message?.text } as Field,
          liveConv,
        ));

        // ASSERTION 4: the state row is not ERROR, and carries no error payload.
        const row = await waitFor(async () => {
          const s = await getState(chatbase, userId, liveConv.accountId);
          return s && s.current_state !== 'RESPONDING' ? s : null;
        }, 30000);
        row.current_state.should.not.equal('ERROR');
        (row.state_json.error === undefined).should.equal(true);

        // ASSERTION 5: the account on the row matches the account the event
        // arrived on, and the conversation is still on its own form.
        row.pageid.should.equal(liveConv.accountId);
        row.state_json.md.pageid.should.equal(liveConv.accountId);
        row.state_json.forms.slice(-1)[0].should.equal(liveForm);

        // ASSERTION 6: still no FIELD_NOT_FOUND by the end of the interaction.
        const logs = await replybotLogsSince(marker);
        logs.should.not.include('FIELD_NOT_FOUND');
        }
      });
    });

    // ---------------------------------------------------------------- B2-2
    // The WhatsApp twin of B2-1. Deterministic pre-fix, because wa_id is global.
    it('B2-2 [RED until §7.1]: §1.1 reproduction on two WhatsApp numbers', async () => {
      const userId = '1541' + Math.floor(Math.random() * 1e6);
      const liveConv = onWaB(userId);
      const entryConv = onWaA(userId);
      const liveFields = getFields('forms/isoFormB.json');
      const entryFields = getFields('forms/isoFormA.json');
      const marker = Math.floor(Date.now() / 1000);

      await sendMessage(makeReferralFor(liveConv, 'isoFormB'));
      await flowMasterWhatsApp(liveConv, [[ok, liveFields[0], []]]);

      await sendMessage(makeReferralFor(entryConv, 'isoFormA'));
      await flowMasterWhatsApp(entryConv, [[ok, entryFields[0], []]]);

      await sendMessage(makeQRFor(liveFields[0], liveConv, 0));

      // FIELD_NOT_FOUND first -- see the ordering note in B2-1.
      await snooze(4000);
      const earlyLogs = await replybotLogsSince(marker);
      const hits = earlyLogs.split('\n').filter((l) => l.includes('FIELD_NOT_FOUND'));
      if (hits.length > 0) {
        throw new Error(
          `FIELD_NOT_FOUND raised on the ${WA_B} conversation after a state write ` +
          `from ${WA_A} -- the §1.1 bug, on WhatsApp:\n${hits.slice(0, 3).join('\n')}`,
        );
      }

      const envelope = await receiveSentEnvelope(liveConv);
      envelope.accountId.should.equal(WA_B);

      // On WhatsApp the send carries no metadata to echo, so message-worker emits
      // the bot_echo itself; give it a moment to advance the state.
      await snooze(1000);

      const row = await waitFor(async () => {
        const s = await getState(chatbase, userId, WA_B);
        return s && s.current_state !== 'RESPONDING' ? s : null;
      }, 30000);
      row.current_state.should.not.equal('ERROR');
      row.state_json.forms.slice(-1)[0].should.equal('isoFormB');

      const logs = await replybotLogsSince(marker);
      logs.should.not.include('FIELD_NOT_FOUND');
    });

    // ---------------------------------------------------------------- B3-1
    // Cross-researcher containment. This is what the dashboard's visibility
    // scoping relies on: dashboard-server/queries/states/states.queries.js
    // scopes `states.pageid` to the accounts the requesting owner holds, so a row
    // written under the WRONG account is a row the wrong researcher can read.
    //
    // OBSERVED PRE-FIX FAILURE: researcher A's answer text appears in the qa
    // transcript of the row scoped to researcher B's account, and response rows
    // carry the other form's question_ref.
    it('B3-1 [RED until §7.1]: one researcher\'s participant data never lands in the other\'s scope', async () => {
      const userId = uuid();
      const convA = onPageA(userId);
      const convB = onPageB(userId);
      const fieldsA = getFields('forms/isoFormA.json');
      const fieldsB = getFields('forms/isoFormB.json');

      const ANSWER_A = 'ANSWER-FOR-R1';

      await sendMessage(makeReferralFor(convA, 'isoFormA'));
      await flowMaster(convA, [[ok, fieldsA[0], []]]);
      await sendMessage(makeReferralFor(convB, 'isoFormB'));
      await flowMaster(convB, [[ok, fieldsB[0], []]]);

      await sendMessage(makeTextResponseFor(convA, ANSWER_A));
      await flowMaster(convA, [[ok, fieldsA[1], []]]);
      await sendMessage(makeQRFor(fieldsB[0], convB, 0));
      await flowMaster(convB, [[ok, fieldsB[1], []]]);

      await waitFor(async () => {
        const s = await getAllStates(chatbase, userId);
        return s.length === 2 ? s : null;
      }, 30000);

      // Responses are scoped to their own account and their own form's refs.
      //
      // DIAGNOSTIC WAIT, not a softened assertion. `responses` rows reach the DB on
      // a DIFFERENT Kafka topic and a DIFFERENT scribble sink than `states` does, so
      // waiting for two states rows says nothing about whether the responses sink
      // has caught up. This polls for the rows the test is about to assert on, and
      // on failure reports what DID arrive -- which is what distinguishes "the row
      // was written on the wrong account" (an isolation bug, the test's subject)
      // from "the responses sink wrote nothing at all" (a sink that is down or
      // crash-looping, which is not this test's subject and must not be reported as
      // if it were). The assertions below are unchanged.
      await waitFor(async () => {
        const a = await getResponses(chatbase, userId, PAGE_A);
        const b = await getResponses(chatbase, userId, PAGE_B);
        return a.length > 0 && b.length > 0 ? true : null;
      }, 30000).catch(async () => {
        const all = await getResponses(chatbase, userId);
        const states = await getAllStates(chatbase, userId);
        throw new Error(
          `B3-1: expected response rows on BOTH accounts for user ${userId} within 30s.\n` +
          `  responses on PAGE_A (${PAGE_A}): ${(await getResponses(chatbase, userId, PAGE_A)).length}\n` +
          `  responses on PAGE_B (${PAGE_B}): ${(await getResponses(chatbase, userId, PAGE_B)).length}\n` +
          `  responses on ANY account:        ${all.length}` +
          (all.length
            ? ` -> ${JSON.stringify(all.map((r: any) => ({ pageid: r.pageid, ref: r.question_ref, resp: r.response })))}`
            : ' (the responses sink wrote NOTHING -- check scribble-responses is alive)') +
          `\n  states rows: ${JSON.stringify(states.map((s: any) => ({ pageid: s.pageid, state: s.current_state, forms: s.state_json && s.state_json.forms })))}`,
        );
      });

      const respA = await getResponses(chatbase, userId, PAGE_A);
      const respB = await getResponses(chatbase, userId, PAGE_B);

      respA.length.should.be.greaterThan(0);
      respB.length.should.be.greaterThan(0);
      respA.forEach((r: any) => {
        r.pageid.should.equal(PAGE_A);
        r.question_ref.should.match(/^isoa_/);
      });
      respB.forEach((r: any) => {
        r.pageid.should.equal(PAGE_B);
        r.question_ref.should.match(/^isob_/);
      });

      // Researcher A's answer text must not appear anywhere in researcher B's
      // scope -- not in a response row, and not in the state transcript.
      JSON.stringify(respB).should.not.include(ANSWER_A);
      const rowB = must(await getState(chatbase, userId, PAGE_B), 'states row on page B');
      JSON.stringify(rowB.state_json.qa).should.not.include(ANSWER_A);

      // And no response row for either account carries the other form's refs.
      const all = await getResponses(chatbase, userId);
      all.length.should.equal(respA.length + respB.length);
    });

    // ---------------------------------------------------------------- B3-2
    // md must not cross either. §2.2 item 2 calls out payment fields
    // specifically: state.md is what carries e_payment_* results, and md is
    // exactly what a shared cache blob merges.
    it('B3-2 [RED until §7.1]: md does not cross between accounts', async () => {
      const userId = uuid();
      const convA = onPageA(userId);
      const convB = onPageB(userId);
      const fieldsA = getFields('forms/isoFormA.json');
      const fieldsB = getFields('forms/isoFormB.json');

      await sendMessage(makeReferralFor(convA, 'isoFormA'));
      await flowMaster(convA, [[ok, fieldsA[0], []]]);
      await sendMessage(makeReferralFor(convB, 'isoFormB'));
      await flowMaster(convB, [[ok, fieldsB[0], []]]);

      await waitFor(async () => {
        const s = await getAllStates(chatbase, userId);
        return s.length === 2 ? s : null;
      }, 30000);

      const rowA = must(await getState(chatbase, userId, PAGE_A), 'states row on page A');
      const rowB = must(await getState(chatbase, userId, PAGE_B), 'states row on page B');

      // The forms differ, so md.form must differ. A shared blob makes them equal.
      rowA.state_json.md.form.should.not.equal(rowB.state_json.md.form);
      rowA.state_json.md.pageid.should.equal(PAGE_A);
      rowB.state_json.md.pageid.should.equal(PAGE_B);

      // Neither md carries the other account's id under any key.
      JSON.stringify(rowA.state_json.md).should.not.include(PAGE_B);
      JSON.stringify(rowB.state_json.md).should.not.include(PAGE_A);
    });

    // ---------------------------------------------------------------- B8
    // Replay. BLOCKED ON A8 (the messages sink) -- without an archived event log
    // there is nothing to replay and every assertion here passes VACUOUSLY,
    // which is the worst outcome available in this exercise. Hence the guard.
    describe('B8: replay is scoped to the conversation', function () {
      this.timeout(120000);

      // THE OLD "HARD BLOCKER" IS GONE. Recorded because the note it replaces
      // survived long after it stopped being true, and three tests carried a
      // stale `[RED: needs chatbase-postgres@0.2.0 published]` tag because of it.
      //
      // The scoped `get()` used to live in the separate package
      // @vlab-research/chatbase-postgres, which the replybot image installed from
      // the npm registry -- so these tests could not go green until 0.2.0 was
      // published AND `replybot/package.json`'s `^0.1.0` was bumped (a caret on a
      // 0.x pins the MINOR, so publishing alone changed nothing).
      //
      // That package no longer exists. It was absorbed into `replybot/lib/chatbase/`,
      // and stack.ts builds replybot from `repoRoot/replybot`'s Dockerfile, which
      // copies the tree in. The harness and production now build the scoped client
      // from the SAME source the assertions live beside -- which is the property
      // the registry split never had. Nothing here is blocked on a publish.
      //
      // B8-5a is no longer vacuous either. It used to pass only because `get()`
      // was unscoped (every archived row returned to every account), so its green
      // was evidence that nothing was scoped. Now that scoping is live, B8-5a and
      // B8-5b together are meaningful: B8-5a proves NULL-account_id rows are still
      // tolerated, B8-5b proves a populated NON-MATCHING account is excluded --
      // and B8-5b is the one that distinguishes the tolerant contract from having
      // no account predicate at all.

      // NON-VACUITY GUARD. Asserts a POSITIVE, SPECIFIC archived-row count --
      // not merely non-zero -- before any replay assertion is allowed to run.
      // If the messages sink is not running, or `chat-events` is not being
      // archived, this fails LOUDLY rather than letting the suite look green.
      async function guardArchived(userId: string, atLeast: number): Promise<number> {
        const n = await waitFor(async () => {
          const c = await countMessages(chatbase, userId);
          return c >= atLeast ? c : null;
        }, 30000).catch(async () => {
          const actual = await countMessages(chatbase, userId);
          throw new Error(
            `B8 NON-VACUITY GUARD FAILED: expected at least ${atLeast} archived ` +
            `rows in chatroach.messages for user ${userId}, found ${actual}. ` +
            'Every replay assertion below would pass vacuously against an empty ' +
            'log, so the suite refuses to run them. Check that the scribble ' +
            'messages sink (A8) is running and consuming chat-events.',
          );
        });
        return n as number;
      }

      // Insert an archived event directly into chatroach.messages, in exactly the
      // shape scribble writes it TODAY: scribble/message.go's SendBatch inserts
      // (userid, timestamp, content, account_id, platform), taking the Kafka key as
      // userid and the raw body as content; `hsh` is a computed fnv64a(content).
      //
      // THE ACCOUNT COLUMNS ARE LOAD-BEARING HERE AND WERE MISSING. This helper
      // used to insert (userid, timestamp, content) only -- true to message.go
      // before migration 26 added the columns, and stale the moment it landed. The
      // consequence was not a weak test but a CONTRADICTORY one: B8-1b seeded two
      // NULL-account rows and then demanded they be scoped apart, while B8-5a
      // asserts NULL-account rows ARE replayed (the deliberate migration-tolerance
      // clause -- see the DO NOT TIGHTEN note on B8-5a). Both cannot hold. The
      // decisive control is that B8-1 passes: the end-to-end version, whose log is
      // built by the real pipeline, proves replay scoping genuinely works. Only the
      // fabricated rows leaked, because they were fabricated wrong.
      //
      // For a row that deliberately predates the backfill, use
      // seedHistoricalArchivedEvent below -- explicitly, so a NULL account is
      // always a choice a test made rather than a shape the helper drifted into.
      //
      // WHY THIS EXISTS. Pre-§7.1 it is IMPOSSIBLE to establish two clean
      // conversations for one participant by driving the pipeline: the second
      // entry is contaminated either through the shared cache key or, on a miss,
      // through the shared replay. So an end-to-end two-conversation setup cannot
      // be built until §7.1 lands, which would make the whole of §7.5 untestable
      // until then.
      //
      // Seeding the log directly breaks that circular dependency. The replay path
      // reads `messages`, so a log containing both conversations' events is all
      // §7.5 needs in order to be exercised -- independent of whether the cache is
      // yet keyed correctly. This lets §7.4/§7.5 be developed and verified before
      // or in parallel with §7.1.
      const archivedContent = (
        accountId: string,
        platform: 'messenger' | 'whatsapp',
        body: any,
        timestamp: number,
      ): string => JSON.stringify({
        ...body,
        source: platform,
        account_id: accountId,
        platform,
        timestamp,
      });

      async function seedArchivedEvent(
        userId: string,
        accountId: string,
        platform: 'messenger' | 'whatsapp',
        body: any,
        timestamp: number,
      ): Promise<void> {
        await chatbase.pool.query(
          `INSERT INTO messages(userid, timestamp, content, account_id, platform)
           VALUES($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [userId, new Date(timestamp), archivedContent(accountId, platform, body, timestamp),
            accountId, platform],
        );
      }

      // A row as it exists BEFORE the §7.4 backfill reaches it: content carries the
      // account (it always did -- it is inside the event body), but the columns are
      // NULL. `messages.account_id` is nullable precisely so the backfill can be
      // incremental, and scribble/message.go declares AccountID as *string for the
      // same reason, so this is a real shape and not a fabrication.
      //
      // Only B8-5a and B8-5b's first row want this. Everything else wants a row
      // that looks like what scribble writes now.
      async function seedHistoricalArchivedEvent(
        userId: string,
        accountId: string,
        platform: 'messenger' | 'whatsapp',
        body: any,
        timestamp: number,
      ): Promise<void> {
        await chatbase.pool.query(
          'INSERT INTO messages(userid, timestamp, content) VALUES($1, $2, $3) ON CONFLICT DO NOTHING',
          [userId, new Date(timestamp), archivedContent(accountId, platform, body, timestamp)],
        );
      }

      // A Messenger referral as hermes produces it, post-envelope-work.
      const referralBody = (userId: string, accountId: string, formId: string) => ({
        sender: { id: userId },
        recipient: { id: accountId },
        referral: { ref: `form.${formId}`, source: 'SHORTLINK', type: 'OPEN_THREAD' },
      });

      // ------------------------------------------------------------- B8-1b
      // Replay scoping, isolated from cache scoping.
      //
      // Seeds an archived log containing TWO conversations for one participant --
      // researcher A's isoFormA on page A, researcher B's isoFormB on page B --
      // then forces a miss and drives a single event on account A. Replay must
      // reconstruct account A's conversation ONLY.
      //
      // Gated on §7.4+§7.5 alone; deliberately NOT on §7.1, unlike B8-1/B8-2.
      //
      // OBSERVED PRE-FIX: chatbase.get()'s `WHERE userid = $1` returns both
      // accounts' rows, so the reconstructed state carries researcher B's form and
      // refs alongside A's.
      //
      // ITS ORIGINAL JUSTIFICATION HAS EXPIRED -- RETIREMENT CANDIDATE, flagged and
      // deliberately NOT acted on unilaterally.
      //
      // B8-1b exists solely to break a circular dependency: §7.5 could not be
      // verified end to end until §7.1 landed, because two clean conversations for
      // one participant could not even be SET UP while the cache key was shared.
      // §7.1 has landed and B8-1 -- the end-to-end version, whose log is built by
      // the real pipeline -- passes. The dependency is gone, and what B8-1b now
      // asserts is a strict subset of B8-1, from fabricated rows rather than real
      // ones. Fabricated rows are also how it went wrong: the seeder drifted out of
      // step with migration 26 and the test silently began demanding the opposite
      // of B8-5a.
      //
      // The counter-argument for keeping it: it is fast, it is the only §B8 test
      // that isolates the replay query from the whole pipeline, and if §7.1 ever
      // regresses it is the one replay test that would still localise the fault.
      // That is a real if narrow value. Recommendation recorded; decision is the
      // plan owner's.
      it('B8-1b: replay reads only the conversation\'s own archived events', async () => {
        const userId = uuid();
        const convA = onPageA(userId);
        const convB = onPageB(userId);
        const base = Date.now() - 600000;

        // Two conversations in the archived log, interleaved in time.
        await seedArchivedEvent(userId, PAGE_A, 'messenger', referralBody(userId, PAGE_A, 'isoFormA'), base);
        await seedArchivedEvent(userId, PAGE_B, 'messenger', referralBody(userId, PAGE_B, 'isoFormB'), base + 1000);

        // Guard: the log really does hold both, so a green result cannot come from
        // an empty log.
        const archived = await guardArchived(userId, 2);
        archived.should.be.greaterThan(1);

        // No cache for either conversation -> the next event must replay.
        await forceCacheMiss(convA, convB);

        // Drive account A. Its state must be rebuilt from A's events alone.
        await sendMessage(makeTextResponseFor(convA, 'replay-scoping-probe'));

        const rowA = await waitFor(async () => {
          const r = await getState(chatbase, userId, PAGE_A);
          return r && r.state_json && r.state_json.forms ? r : null;
        }, 30000);

        rowA.state_json.forms.should.eql(['isoFormA']);
        rowA.state_json.md.pageid.should.equal(PAGE_A);
        const qa = JSON.stringify(rowA.state_json.qa || []);
        if (qa.includes('isob_')) {
          throw new Error(
            "replay for account A included account B's archived events -- " +
            `chatbase.get() is keyed on userid alone. A's qa: ${qa}`,
          );
        }
      });

      // -------------------------------------------------------------- B8-1
      // A cache miss must replay ONLY that conversation's events.
      //
      // OBSERVED PRE-FIX FAILURE: chatbase.get() is `WHERE userid = $1`, so the
      // replay interleaves BOTH conversations' events (§2.2 item 3), and the
      // LEFT JOIN on states USING (userid) returns one row per account, so every
      // message row is duplicated N times (§2.2 item 4).
      // GATING, stated precisely: this test's SETUP needs §7.1, not just §7.5.
      // Establishing two live conversations for one participant is impossible while
      // the cache key is shared -- the second entry stitches onto the first (see
      // B2-1's captured output). So pre-§7.1 this fails during setup, at the
      // second flowMaster, with a receive() error rather than at its replay
      // assertion. B8-1b above tests the same replay property WITHOUT that
      // dependency, by seeding the archived log directly; keep both, because this
      // one is the end-to-end proof and B8-1b is the one that can go green first.
      it('B8-1 [RED until §7.1+§7.4+§7.5]: a cache miss replays only that conversation', async () => {
        const userId = uuid();
        const convA = onPageA(userId);
        const convB = onPageB(userId);
        const fieldsA = getFields('forms/isoFormA.json');
        const fieldsB = getFields('forms/isoFormB.json');

        // Build history on both accounts.
        await sendMessage(makeReferralFor(convA, 'isoFormA'));
        await flowMaster(convA, [[ok, fieldsA[0], []]]);
        await sendMessage(makeTextResponseFor(convA, 'blue'));
        await flowMaster(convA, [[ok, fieldsA[1], []]]);

        await sendMessage(makeReferralFor(convB, 'isoFormB'));
        await flowMaster(convB, [[ok, fieldsB[0], []]]);

        // GUARD FIRST. Four inbound events minimum: referral + answer on A,
        // referral + answer on B... conservatively require 4.
        await guardArchived(userId, 4);

        // Force a cache miss for account A. Asserting >0 proves a miss was really
        // forced, so a green result cannot come from "the cache was still warm".
        const removed = await forceCacheMiss(convA);
        removed.should.be.greaterThan(0);

        // Drive account A again. Replybot must reconstruct A's state from the
        // log alone.
        await sendMessage(makeTextResponseFor(convA, '7'));

        const envelope = await receiveSentEnvelope(convA);
        envelope.accountId.should.equal(PAGE_A);
        await sendMessage(makeEchoFor(
          { metadata: envelope.data.message?.metadata, text: envelope.data.message?.text } as Field,
          convA,
        ));

        const rowA = await waitFor(async () => {
          const s = await getState(chatbase, userId, PAGE_A);
          return s && s.state_json.qa && s.state_json.qa.length >= 2 ? s : null;
        }, 30000);

        // THE ASSERTION. A's replayed transcript contains A's refs and NONE of B's,
        // and A's form stack is A's alone.
        //
        // PRE-FIX this fails because chatbase.get() is `WHERE userid = $1`: the
        // replay pulls BOTH conversations' archived events, interleaved, and the
        // reconstructed state carries researcher B's form and answers (§2.2 item
        // 3). The LEFT JOIN on states USING (userid) additionally returns one row
        // per account, duplicating every message row N times (§2.2 item 4).
        const qa = JSON.stringify(rowA.state_json.qa);
        qa.should.include('isoa_');
        if (qa.includes('isob_')) {
          throw new Error(
            "replay on account A picked up account B's events -- chatbase.get() is " +
            'keyed on userid alone, so both conversations replay interleaved. ' +
            `A's qa was: ${qa}`,
          );
        }
        rowA.state_json.forms.should.eql(['isoFormA']);

        // B is untouched by A's replay.
        const rowB = must(await getState(chatbase, userId, PAGE_B), 'states row on page B');
        rowB.state_json.forms.slice(-1)[0].should.equal('isoFormB');
      });

      // -------------------------------------------------------------- B8-2
      // The message_pointer leak, §2.2 item 4.
      //
      // OBSERVED PRE-FIX FAILURE: chatbase.get()'s
      //   LEFT JOIN (SELECT userid, message_pointer FROM states WHERE userid=$1)
      //   USING (userid)
      // returns one row per account the participant holds state on. The pointer
      // checkpoint therefore passes if ANY account's pointer allows it, so a
      // form.reset on account A silently stops history truncation on account B,
      // and message rows are duplicated N times in the replay.
      // Same setup dependency on §7.1 as B8-1 -- see the note there. This is the
      // subtlest bug in the plan (§2.2 item 4) and has no isolated variant yet:
      // the pointer checkpoint is a property of the states/messages JOIN, so it
      // needs two real states rows with two real pointers.
      it('B8-2 [RED until §7.1 for setup]: form.reset on one account does not stop truncation on the other', async () => {
        const userId = uuid();
        const convA = onPageA(userId);
        const convB = onPageB(userId);
        const fieldsA = getFields('forms/isoFormA.json');
        const fieldsB = getFields('forms/isoFormB.json');

        // History on both.
        await sendMessage(makeReferralFor(convA, 'isoFormA'));
        await flowMaster(convA, [[ok, fieldsA[0], []]]);
        await sendMessage(makeReferralFor(convB, 'isoFormB'));
        await flowMaster(convB, [[ok, fieldsB[0], []]]);
        await sendMessage(makeQRFor(fieldsB[0], convB, 0));
        await flowMaster(convB, [[ok, fieldsB[1], []]]);

        await guardArchived(userId, 4);

        // Reset account A, which sets A's message_pointer (04-pointers.sql, a
        // computed column over state_json.pointer).
        //
        // ROOT CAUSE OF THE ORIGINAL FAILURE (2026-08-17). This step used to
        // re-send a referral to `isoFormA` and expect the survey to restart. That
        // is not what a repeat referral does. `machine.js`'s REFERRAL case:
        //
        //     if (_hasForm(state, form)) {
        //       if (state.state === 'QOUT') return _repeat(state)   // <-- here
        //       return _noop()
        //     }
        //
        // A referral naming a form already in the participant's history REPEATS the
        // outstanding question, and `_repeat` returns
        // `{ action: 'RESPOND', validation: { valid: false } }` -- an invalid-answer
        // repeat. So the test received a VALIDATION REPEAT where it expected a
        // fresh first question, which is exactly the symptom that was observed. No
        // reset ever happened, `state_json.pointer` was never written, and the
        // `message_pointer` wait below could only have timed out afterwards.
        //
        // The ONLY referral branch that sets the pointer is the reset shortcode:
        //
        //     if (form === process.env.REPLYBOT_RESET_SHORTCODE) {
        //       return { action: 'RESET', stateUpdate: { pointer: nxt.timestamp } }
        //     }
        //
        // ...and `REPLYBOT_RESET_SHORTCODE` was NOT SET in the harness at all --
        // `devops/values/{staging,production}.yaml` set it to "reset",
        // `replybot/kube-dev/dev.yaml` does not. stack.ts now supplies it, so the
        // branch is reachable here for the first time.
        //
        // NOTE: a RESET sends NO outbound message. transition.js `run()`
        // short-circuits on `output.action === 'RESET'` and returns before
        // actionsResponses, so there is nothing for flowMaster to receive -- waiting
        // for one is what would hang. Wait on the pointer landing instead.
        await sendMessage(makeReferralFor(convA, RESET_SHORTCODE));

        const pointerA = await waitFor(async () => {
          const s = await getState(chatbase, userId, PAGE_A);
          return s && s.message_pointer ? s : null;
        }, 30000).catch(async () => {
          const s: any = await getState(chatbase, userId, PAGE_A);
          throw new Error(
            `B8-2: account A never got a message_pointer after a '${RESET_SHORTCODE}' ` +
            'referral, so the pointer half of this test has nothing to measure. ' +
            'Check REPLYBOT_RESET_SHORTCODE reached the replybot container (stack.ts). ' +
            `states row on PAGE_A: ${JSON.stringify(s && {
              current_state: s.current_state,
              message_pointer: s.message_pointer,
              pointer: s.state_json && s.state_json.pointer,
              forms: s.state_json && s.state_json.forms,
            })}`,
          );
        });
        (pointerA.message_pointer === null).should.equal(false);

        // Force a cache miss on B and replay it.
        (await forceCacheMiss(convB)).should.be.greaterThan(0);
        await sendMessage(makeTextResponseFor(convB, 'more feedback'));
        await receiveSentEnvelope(convB);

        const rowB = await waitFor(async () => {
          const s = await getState(chatbase, userId, PAGE_B);
          return s && s.state_json.qa ? s : null;
        }, 30000);

        // B's replay is truncated at B's OWN pointer: B is still on isoFormB and
        // its transcript never picked up A's events.
        rowB.state_json.forms.slice(-1)[0].should.equal('isoFormB');
        JSON.stringify(rowB.state_json.qa).should.not.include('isoa_');

        // And no message appears twice -- that is the multi-row duplication,
        // separately observable from the pointer bug.
        const msgs = await getChatLog(chatbase, userId, PAGE_B);
        const keys = msgs.map((m: any) => `${m.timestamp}|${m.direction}|${m.content}`);
        new Set(keys).size.should.equal(keys.length);
      });

      // -------------------------------------------------------------- B8-3
      // §7.4: the archived rows must carry the account and the platform. This is
      // the test that gates the §7.4 backfill being implementable at all -- if
      // the forward path does not stamp these, there is nothing for §7.5 to key
      // on.
      //
      // OBSERVED PRE-FIX FAILURE: `messages` has no account_id column at all
      // (01-init.sql:17-30), so responses.getMessages() throws the descriptive
      // "migration 26 has not landed" error by design rather than returning [].
      it('B8-3 [RED until §7.4]: archived messages carry account_id and platform', async () => {
        const userId = uuid();
        const conv = onPageA(userId);
        const fields = getFields('forms/isoFormA.json');

        await sendMessage(makeReferralFor(conv, 'isoFormA'));
        await flowMaster(conv, [[ok, fields[0], []]]);
        await guardArchived(userId, 1);

        const rows = await getMessages(chatbase, userId, PAGE_A);
        rows.length.should.be.greaterThan(0);
        rows.forEach((r: any) => {
          r.account_id.should.equal(PAGE_A);
          r.platform.should.equal('messenger');
        });
      });

      // -------------------------------------------------------------- B8-4
      // DELIBERATELY NOT WRITTEN HERE -- covered better elsewhere.
      //
      // Backfill correctness is proved at layers closer to the code than this one:
      //
      //   - PARITY (the SQL rule vs the Go rule): scribble's TestBackfillSQLMatchesGo
      //     evaluates devops/sql/messages-{account-id,platform}-expr.sql -- the
      //     actual files the batched UPDATE substitutes -- against the shared echo
      //     fixture and asserts they agree with ConversationFromHistoricalContent.
      //     Drift-verified: inverting `= 'true'` to `!= 'true'` fails exactly the
      //     three echo vectors.
      //   - REAL-SHAPE BEHAVIOUR, poison resilience, idempotency, resumability:
      //     the §7.4 stream's own suite over devops/backfill-messages-account.sh.
      //
      // A version here would have to FABRICATE historical rows, because the harness
      // is a fresh database in which every row is written by current code -- the
      // same structural fact that broke this file's first B8-6 mechanism. That
      // would duplicate the stream's test while sitting further from the code and
      // giving a worse failure signal.
      //
      // The forward/backward consistency question -- does the backfill's derivation
      // agree with what the live pipeline actually writes -- is already B8-3 above,
      // in its only meaningful form. And the forward/backward OVERWRITE seam does
      // not exist: backfill-messages-account.sh:348's UPDATE carries
      // `AND account_id IS NULL`, so forward-written rows are excluded by
      // construction and there is nothing for the backfill to clobber.
      //
      // If the backfill ever gains a branch that WRITES over a non-NULL
      // account_id, this decision is void and B8-4 must be written.

      // -------------------------------------------------------------- B8-5
      // THE MIGRATION-WINDOW CONTRACT for chatbase.get().
      //
      // CONTRACT (decided 2026-08-17, deliberately NOT the strict form):
      //     WHERE userid = $1 AND (account_id = $2 OR account_id IS NULL)
      //
      // An earlier revision of this test pinned the STRICT contract -- that a
      // tuple-keyed get() returns EMPTY for rows whose account_id is NULL -- and
      // thereby forced "§7.4 fully backfilled before §7.5 ships". That was wrong,
      // and the reason is `STATE_STORE_LIMIT=30000` combined with
      // `ORDER BY timestamp ASC`: replay reads the OLDEST 30k events, not the
      // newest. So under the strict contract any conversation whose *old* events
      // are not yet backfilled replays as EMPTY -- turning the "every existing
      // conversation replays as empty" catastrophe from a sequencing risk into a
      // guarantee. There is no recency bound to exploit precisely because of that
      // ASC ordering, and a full backfill is ~106M rows of write amplification
      // (87% of `messages` predates 2025-02; only ~8% is newer than 2026-01-01).
      //
      // Under the tolerant contract, historical un-backfilled rows behave exactly
      // as they do today -- no better, no worse -- new rows are strictly scoped,
      // and the clause becomes a no-op as the backfill drains.
      //
      // DO NOT "TIGHTEN" THIS BACK. Returning NULL-account_id rows is not a leak;
      // it is the only thing standing between the backfill and mass conversation
      // loss. See the test plan's finding on the ASC-ordering fact.
      it('B8-5a: a NULL-account_id archived row IS replayed (tolerant migration contract)', async () => {
        const userId = uuid();
        const conv = onPageA(userId);
        const base = Date.now() - 600000;

        // A historical-shaped archived row: no account_id column value at all.
        // Pre-migration-26 that is inherent; post-26 it is an un-backfilled row.
        await seedHistoricalArchivedEvent(userId, PAGE_A, 'messenger', referralBody(userId, PAGE_A, 'isoFormA'), base);
        await guardArchived(userId, 1);

        await forceCacheMiss(conv);
        await sendMessage(makeTextResponseFor(conv, 'tolerant-contract-probe'));

        // The conversation MUST be reconstructed from that row. An empty replay
        // here is the catastrophe this contract exists to prevent.
        const row = await waitFor(async () => {
          const r = await getState(chatbase, userId, PAGE_A);
          return r && r.state_json && r.state_json.forms ? r : null;
        }, 30000);

        row.state_json.forms.should.include('isoFormA');
      });

      // The other half, and the important one: tolerance must not collapse into
      // "no scoping at all". A row with a POPULATED, NON-MATCHING account_id must
      // still be excluded. Without this assertion the tolerant clause is
      // indistinguishable from having no account predicate whatsoever.
      it('B8-5b: a populated NON-MATCHING account_id row is NOT replayed', async () => {
        if (!(await messagesHasAccountColumn(chatbase))) {
          throw new Error(
            'B8-5b cannot run: chatroach.messages has no account_id column yet ' +
            '(migration 26 / §7.4). This test is the ONLY thing proving the tolerant ' +
            'contract still scopes by account rather than degenerating into no ' +
            'predicate at all, so it must not be skipped silently once 26 lands.',
          );
        }

        const userId = uuid();
        const convA = onPageA(userId);
        const base = Date.now() - 600000;

        // One un-backfilled row for A (NULL -> must be included) ...
        await seedHistoricalArchivedEvent(userId, PAGE_A, 'messenger', referralBody(userId, PAGE_A, 'isoFormA'), base);
        // ... and one fully-backfilled row belonging to researcher B (populated,
        // non-matching -> must be excluded).
        await seedArchivedEvent(userId, PAGE_B, 'messenger', referralBody(userId, PAGE_B, 'isoFormB'), base + 1000);

        await guardArchived(userId, 2);
        await forceCacheMiss(convA);
        await sendMessage(makeTextResponseFor(convA, 'scoping-still-works-probe'));

        const row = await waitFor(async () => {
          const r = await getState(chatbase, userId, PAGE_A);
          return r && r.state_json && r.state_json.forms ? r : null;
        }, 30000);

        row.state_json.forms.should.include('isoFormA');   // NULL row: included
        row.state_json.forms.should.not.include('isoFormB'); // populated other account: excluded
      });

      // -------------------------------------------------------------- B8-6
      // THE REMOVAL CONDITION -- intent guard, in the half that a test can
      // actually own.
      //
      // The NULL branch is explicitly temporary, and temporary is what becomes
      // permanent by accident once the pressure that created it is gone. But note
      // carefully WHERE the removal trigger can live:
      //
      //   - "The tolerance still works"        -> a harness test. That is B8-5a.
      //   - "The tolerance is still NEEDED"    -> a PRODUCTION query. NOT a harness
      //                                           test.
      //
      // An earlier version of this test asserted that NULL account_id rows still
      // exist in the harness DB, intending to fail once the backfill completed and
      // thereby force the cleanup conversation. That was wrong, and it failed
      // immediately for the wrong reason: the harness is a FRESH database in which
      // every row is written by current code, so it has zero NULL rows BY
      // CONSTRUCTION. Production has ~106M of them. A fresh-DB row count says
      // nothing whatsoever about production's backfill progress, so the assertion
      // was a false positive dressed up as a tripwire.
      //
      // The removal trigger therefore belongs with the other production-data
      // invariants (alongside §5.3's registry count check), and is specified in the
      // plan. What THIS test owns is the intent: the decision must stay written down
      // and greppable, so that whoever finds the odd-looking `OR account_id IS NULL`
      // clause finds the reasoning rather than guessing at it -- and so that
      // deleting the tolerance means deleting a documented decision on purpose,
      // not quietly tightening a WHERE clause.
      it('B8-6: the NULL-account_id tolerance keeps its documented removal condition', async () => {
        const REMOVAL_MARKER = 'NULL-ACCOUNT-ID TOLERANCE REMOVAL CONDITION';

        // Walk up to the repo root rather than hard-coding a depth. At runtime
        // __dirname is facebot/testrunner/dist, NOT facebot/testrunner -- the same
        // gotcha stack.ts:92 calls out -- so a fixed '../../' silently resolves to
        // facebot/ and this test fails on ENOENT instead of on its actual subject.
        function repoRoot(): string {
          let dir = __dirname;
          for (let i = 0; i < 6; i++) {
            if (fs.existsSync(path.join(dir, 'planning'))) return dir;
            dir = path.dirname(dir);
          }
          throw new Error(`could not locate repo root (no planning/ above ${__dirname})`);
        }
        const planPath = path.join(repoRoot(), 'planning/conversation-identity-test-plan.md');
        const plan = fs.readFileSync(planPath, 'utf-8');

        if (!plan.includes(REMOVAL_MARKER)) {
          throw new Error(
            `The tolerant NULL-account_id contract must stay documented: expected the ` +
            `marker "${REMOVAL_MARKER}" in ${planPath}.\n` +
            'If you removed the tolerance deliberately, delete B8-5a and this test in ' +
            'the same change and tighten B8-5b to the strict contract. If you removed ' +
            'the DOCUMENTATION but kept the clause, put it back -- an undocumented ' +
            'permanent-looking migration hack is exactly what this guards against.',
          );
        }

        // And the condition must still name the observable that decides it, so the
        // marker cannot decay into a bare heading.
        plan.should.include('account_id IS NULL');
      });
    });

    // ---------------------------------------------------------------- B10-8
    // A tuple-less event must still advance the conversation -- degraded to a
    // replay, never an error. This is what makes §7.1's no-fallback rule safe to
    // ship: refusing to touch the cache must not refuse to serve the participant.
    it('B10-8 [RED until §7.1]: a synthetic event with no platform still advances the conversation', async () => {
      const userId = uuid();
      const conv = onPageA(userId);
      const fields = getFields('forms/isoFormA.json');

      await sendMessage(makeReferralFor(conv, 'isoFormA'));
      await flowMaster(conv, [[ok, fields[0], []]]);

      // WAIT FOR THE ARCHIVE FIRST -- this is a non-vacuity guard, in the same
      // spirit as §B8's, and without it this test measures a race instead of its
      // subject.
      //
      // A tuple-less event MUST NOT touch the cache (§7.1, B10-4/B10-5), so it is
      // served by a REPLAY of chatroach.messages. If the scribble messages sink has
      // not archived the referral yet, that replay returns an EMPTY log, the state
      // reconstructs as START, and machine.js's `_handleExternalEvent` takes its
      //
      //     if (state.state === 'START') return _blankStart(nxt)
      //
      // branch -- which calls getMetadata() on an event with no referral ref, so
      // `md.form` falls through to FALLBACK_FORM and the conversation is switched
      // onto survey '305'. That is exactly the observed failure:
      // `expected '305' to equal 'isoFormA'`.
      //
      // NOT ONLY A TEST BUG -- see the note in the README. The same window exists
      // in production: §7.1's "refuse the cache, degrade to a replay" is only as
      // safe as the archive is current, and inside the archive lag a tuple-less
      // synthetic silently re-enters the participant on the fallback survey rather
      // than erroring. Making the harness wait keeps THIS test on its own subject;
      // the production exposure is reported separately.
      await waitFor(async () => {
        const n = await countMessages(chatbase, userId);
        return n >= 2 ? n : null;
      }, 30000).catch(async () => {
        throw new Error(
          `B10-8: the archive never caught up for user ${userId} (found ` +
          `${await countMessages(chatbase, userId)} rows in chatroach.messages, wanted >= 2). ` +
          'A tuple-less event is served by REPLAY, so with an empty log this test ' +
          'would assert against a state reconstructed from nothing.',
        );
      });

      // A synthetic event carrying NEITHER platform NOR account_id -- the shape
      // replybot's own machine_report posts today (lib/index.js:14-28).
      await sendMessage(makeSyntheticRaw({
        user: userId,
        page: PAGE_A,
        event: { type: 'external', value: { type: 'moviehouse:play', id: 'noop' } },
      }));

      // The conversation must still be alive and still on its own form.
      const row = await waitFor(async () => {
        const s = await getState(chatbase, userId, PAGE_A);
        return s ? s : null;
      }, 30000);
      row.current_state.should.not.equal('ERROR');
      row.state_json.forms.slice(-1)[0].should.equal('isoFormA');
    });
  });
});

/// <reference types="node" />
import 'chai';
import parallel from 'mocha.parallel';
import sendMessage from './sender';
import { makeQR, makePostback, makeTextResponse, makeReferral, makeSynthetic, getFields, fieldsFromForm, makeNotify, makeEcho, makeHandover, makeWhatsAppReferral, makeWhatsAppText, makeWhatsAppReply, Field } from './mox';
import { v4 as uuid } from 'uuid';
import farmhash from 'farmhash';
import { seed } from './seed-db';
import { flowMaster, flowMasterWhatsApp, TestFlow, ErrorResponse, SuccessResponse, receiveSent } from './socket';
import { snooze, waitFor } from './utils';
import { getResponses, getState } from './responses';
import { startStack, stopStack, Stack } from './stack';
import { triggerDean } from './dean-trigger';
import { Pool } from 'pg';
import mustache from 'mustache';
import fs from 'fs';

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
    console.log('Test starting!');
  });

  after(async function() {
    this.timeout(60000);
    if (process.env.KEEP_STACK) {
      console.log('KEEP_STACK set; leaving stack running. Press Ctrl-C to teardown.');
      await new Promise(() => {});
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
      state.state_json.error.tag.should.equal('FORM_NOT_FOUND');
      state.state_json.error.status.should.equal(404);
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
});

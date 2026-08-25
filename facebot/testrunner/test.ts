/// <reference types="node" />
import 'chai';
import parallel from 'mocha.parallel';
import sendMessage from './sender';
import { makePostback, makeTextResponse, makeReferral, getFields } from './mox';
import { v4 as uuid } from 'uuid';
import farmhash from 'farmhash';
import { seed } from './seed-db';
import { flowMaster, TestFlow, ErrorResponse, SuccessResponse, receiveSent } from './socket';
import { snooze } from './utils';
import { getResponses, getState } from './responses';
import mustache from 'mustache';
import fs from 'fs';
import { Pool } from 'pg';

///////////////////////////////////////////////
// SETUP -----------------------------------
//
// A plain `pg.Pool`, not `@vlab-research/chatbase-postgres` and not replybot's
// vendored `lib/chatbase` either.
//
// This used to be `new (require(process.env.CHATBASE_BACKEND ||
// '@vlab-research/chatbase-postgres'))()`, pinned at 0.0.3 while replybot ran
// 0.2.0 -- four versions of skew. The skew turned out to be INERT: nothing in
// this suite ever called `.get()` or `.put()`. `seed()`, `getState()`,
// `getResponses()` and friends all take `{ pool }` (see the local `interface
// Chatbase` in `responses.ts` and `seed-db.ts`), so the client was only ever a
// wrapper for building a Pool out of the CHATBASE_* env vars. `test.tc.ts`
// already does exactly this, with `chatbase = { pool }`.
//
// Requiring replybot's vendored module instead would NOT work here: this file
// runs inside the testrunner image, whose Docker build context is
// `facebot/testrunner` alone (`.github/workflows/release.yml`, `dev.sh`), so
// `../../replybot/lib/chatbase` does not exist at runtime. Reaching into
// replybot for a Pool constructor would also be coupling for nothing.
//
// The env defaults and the required-variable guard below are the ones the old
// client's constructor applied, kept so a misconfigured job still fails fast
// with a message that names what is missing.
const CHATBASE_PORT = process.env.CHATBASE_PORT;
const CHATBASE_HOST = process.env.CHATBASE_HOST;
const CHATBASE_DATABASE = process.env.CHATBASE_DATABASE;

if (!CHATBASE_PORT || !CHATBASE_HOST || !CHATBASE_DATABASE) {
  throw new TypeError(
    '(CHATBASE_DATABASE, CHATBASE_PORT, CHATBASE_HOST) are strictly required',
  );
}

const chatbase = {
  pool: new Pool({
    user: process.env.CHATBASE_USER,
    host: CHATBASE_HOST,
    database: CHATBASE_DATABASE,
    password: process.env.CHATBASE_PASSWORD,
    port: Number(CHATBASE_PORT),
  }),
};
chatbase.pool.on('error', (err) => { throw err });

const ok: SuccessResponse = { res: 'success' };
const err: ErrorResponse = { error: { message: 'test error', code: 555 } };

function interpolate(str: string, values: Record<string, string>): string {
  return mustache.parse(str)
    .map((token: any[]) => {
      const [type, value] = token;
      return type === 'name' ? values[value] : value;
    })
    .join('');
}

///////////////////////////////////////////////
// TESTS -----------------------------------
//
// This is the k8s deployment SMOKE subset, not a functional-coverage suite.
// Full logic coverage lives in test.tc.ts (testcontainers) -- this file only
// needs to prove what testcontainers can't:
//   1. Real service DNS/secrets/ConfigMaps in the dev cluster actually wire up
//      (botserver -> replybot -> worker -> facebot).
//   2. The real dean CronJob fires on its actual schedule and drives a
//      timeout, instead of being triggered imperatively via triggerDean() the
//      way test.tc.ts fakes it.
//   3. A delivery error surfaces through the worker -> scribble -> DB as
//      BLOCKED, the same as it would in production.
// See documentation/testing.md for the two-tier testing strategy.
describe('Test Bot flow Survey Integration Testing', () => {

  before(async () => {
    await seed(chatbase);
    console.log('Test starting!');
  });

  after(() => {
    console.log('Test finished!');
  });

  parallel('Basic Functionality', function () {
    this.timeout(45000);

    it('Sends the first question after a referral (DNS/wiring smoke test)', async () => {
      const userId = uuid();
      const fields = getFields('forms/LDfNCy.json');

      const testFlow: TestFlow = [
        [ok, fields[0], []],
      ];

      await sendMessage(makeReferral(userId, 'LDfNCy'));
      await flowMaster(userId, testFlow);
    });

    it('Puts user into blocked state when given facebook error', async () => {
      const userId = uuid();
      const fields = getFields('forms/LDfNCy.json');

      const testFlow: TestFlow = [
        [err, fields[0], []]
      ];

      await sendMessage(makeReferral(userId, 'LDfNCy'));
      await flowMaster(userId, testFlow);

      // wait for scribble to catch up
      await snooze(8000);
      const state = await getState(chatbase, userId);
      if (!state) throw new Error('State not found');
      state.current_state.should.equal('BLOCKED');
      state.fb_error_code.should.equal('555');
    });

    // utility_message templates are the go-forward re-contact mechanism and
    // were just implemented in the message-worker's translator. test.tc.ts's
    // testcontainers test proves the worker SOURCE builds a UTILITY template
    // correctly; this smoke test proves the ACTUALLY-DEPLOYED message-worker
    // image in the cluster renders it end-to-end -- a deployment/wiring
    // concern (wrong image tag, env misconfig) that only a real-cluster run
    // can catch. We use `receiveSent` (not `flowMaster`/`getFields`) because
    // both of those only ever look at `data.message`, stripping the
    // top-level `messaging_type`/`message.template` fields asserted below.
    it('Sends utility_message fields as a Facebook UTILITY template message (deployed worker smoke test)', async () => {
      const userId = uuid();

      await sendMessage(makeReferral(userId, 'utilityTest'));
      const sent = await receiveSent(userId);

      sent.messaging_type.should.equal('UTILITY');
      sent.message.template.name.should.equal('recontact_test');
      sent.message.template.language.code.should.equal('en_US');

      const components = sent.message.template.components;
      components[0].type.should.equal('body');
      components[0].parameters[0].should.eql({ type: 'text', text: '₦1,000' });

      const buttonsComponent = components.find((c: any) => c.type === 'buttons');
      buttonsComponent.parameters.should.eql([{ type: 'POSTBACK', payload: 'utilityField' }]);
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

      // wait for scribble to catch up
      await snooze(8000);
      const res = await getResponses(chatbase, userId);
      res.length.should.equal(2);
      res.map(r => r['response']).should.include('LOL');
      res.map(r => r['response']).should.include('Yes');
      res.map(r => r['parent_shortcode']).should.eql(['Llu24B', 'Llu24B']);
    });
  });

  parallel('Timeouts', function () {
    this.timeout(180000);

    it('Sends message after timeout absolute timeout (real dean CronJob)', async () => {
      const userId = uuid();
      const timeoutDate = (new Date(Math.floor(Date.now() / 1000 + 60) * 1000)).toISOString();

      const vals = { 'hidden:timeout_date': timeoutDate };
      const form = fs.readFileSync('forms/j1sp7ffL.json', 'utf-8');
      const f = interpolate(form, vals);
      fs.writeFileSync('forms/temp-j1sp7ffL.json', f);

      const fields = getFields('forms/temp-j1sp7ffL.json');

      const testFlow: TestFlow = [
        [ok, fields[0], []],
        [ok, fields[1], [makeTextResponse(userId, 'loved it')]],
        [ok, fields[2], []],
      ];

      // No triggerDean() here -- unlike test.tc.ts, this relies on the real
      // dean CronJob deployed in the cluster to fire on its own schedule and
      // pick up this overdue absolute timeout. flowMaster's polling receive()
      // blocks (up to this block's 180s mocha timeout) until that happens.
      await sendMessage(makeReferral(userId, `j1sp7ffL.timeout_date.${timeoutDate}`));
      await flowMaster(userId, testFlow);
    });
  });
});

import r2 from 'r2';
import util from 'util';
import { should } from 'chai';
import { makeEcho, Field } from './mox';
import sendMessage from './sender';
import { snooze } from './utils';
import type { Conversation } from './conversation';

should();

const facebotUrl = (): string => process.env.FACEBOT_URL || 'http://gbv-facebot';

// ---------------------------------------------------------------------------
// Conversation-scoped polling (A4).
//
// A conversation is (platform, account_id, user_id). The facebot mock keeps ONE
// FIFO per user id -- deliberately, because `chat-events` is keyed by user id so
// a participant's events really are strictly ordered -- but each queued entry now
// records which account it went out on (facebot/receiver/index.js).
//
// A test driving two conversations for the SAME participant on two accounts must
// therefore pop account-scoped, or it cannot tell whose message it just got.
// Everything below accepts EITHER a bare userId (legacy, unscoped -- what the
// ~40 pre-existing tests pass) or a Conversation handle (account-scoped).
// ---------------------------------------------------------------------------

export type Target = string | Conversation;

export const isConversation = (t: Target): t is Conversation =>
  typeof t === 'object' && t !== null && 'accountId' in t && 'userId' in t;

const userIdOf = (t: Target): string => (isConversation(t) ? t.userId : t);

/** The facebot path that pops the next outbound message for this target. */
const sentPath = (t: Target): string =>
  isConversation(t)
    ? `/sent/${encodeURIComponent(t.accountId)}/${encodeURIComponent(t.userId)}`
    : `/sent/${encodeURIComponent(t)}`;

/**
 * Tell the facebot mock which credential token belongs to which account.
 *
 * Required because the account is NOT on the Messenger wire: message-worker
 * POSTs to a fixed /me/messages and identifies the page only through
 * `Authorization: Bearer <token>` (message-worker/messenger_client.go:96-103).
 * The mock resolves token -> account via this registration. WhatsApp needs no
 * registration -- its account is in the request path.
 *
 * Call once in before(), after seed(), passing seed-db's ACCOUNT_TOKENS.
 */
export async function registerAccounts(
  accounts: { token: string; accountId: string; platform: string }[],
): Promise<void> {
  await r2.post(`${facebotUrl()}/accounts`, { json: accounts }).response;
}

export interface SentResponse {
  data?: {
    message: any;
  };
  token?: string;
}

export interface ErrorResponse {
  error: {
    message: string;
    code: number;
  };
}

export interface SuccessResponse {
  res: 'success';
}

export type Response = ErrorResponse | SuccessResponse;
type TestFlowItem = [Response, Field | any, any[], ...string[]];
export type TestFlow = TestFlowItem[];

// How long to wait for an expected outbound message before giving up.
//
// This used to poll forever, which was fine while every test expected a message
// that always arrived. It is NOT fine for the conversation-isolation tests: when
// one conversation's state has been clobbered by another, the expected message
// never arrives at all, and an unbounded poll turns that into a bare
// "Timeout of 120000ms exceeded" from mocha -- which says nothing about WHICH
// conversation stalled or why. A bounded wait with a descriptive error makes the
// failure diagnostic instead of merely red.
const RECEIVE_TIMEOUT_MS = Number(process.env.RECEIVE_TIMEOUT_MS || 45000);

async function receive(target: Target): Promise<SentResponse> {
  const path = sentPath(target);
  const deadline = Date.now() + RECEIVE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const res = await r2.get(`${facebotUrl()}${path}`).json;
    if (res.data) {
      return res;
    }
    await snooze(50);
  }

  const who = isConversation(target)
    ? `user ${target.userId} on ${target.platform} account ${target.accountId}`
    : `user ${target} (unscoped)`;
  throw new Error(
    `receive(): no outbound message arrived for ${who} within ${RECEIVE_TIMEOUT_MS}ms ` +
    `(polled ${path}). Either the conversation never produced a message, or it was ` +
    'produced on a different account than expected.',
  );
}

async function send(token: string, json: any): Promise<any> {
  const res = await r2.post(`${facebotUrl()}/respond/${token}`, {json}).response;
  return res;
}

// Captures the FULL outbound payload the worker POSTed to facebot (not just
// data.message), then acks it so the worker's HTTP call completes. Use for
// asserting top-level messaging_type / tag / template shapes that flowMaster
// (which only ever compares data.message) and mox.getFields (which returns
// only translator(f).message, stripping messaging_type/tag) don't expose.
// See facebot/receiver/index.js: GET /sent/:id returns { data, token } where
// data is the full POST body the worker sent to /me/messages.
// Accepts a bare userId (unscoped) or a Conversation (account-scoped).
export async function receiveSent(target: Target): Promise<any> {
  const sent = await receive(target);          // { data, token } — data is the full POST body
  if (!sent.data || !sent.token) throw new Error('receiveSent: invalid response');
  await send(sent.token, { res: 'success' });  // MUST ack or the worker's POST times out (10s)
  return sent.data;
}

/**
 * Like receiveSent, but returns the mock's full envelope including which
 * account the send actually went out on: { data, token, accountId, platform }.
 *
 * This is what proves an outbound message was sent on the RIGHT account. On
 * Messenger that fact is otherwise invisible -- the page id appears nowhere in
 * the URL or body, only in the bearer token -- so asserting `accountId` here is
 * the only way to catch a conversation that routed its reply to the wrong page
 * (which is what transition.js:27's `state.md.pageid` fallback does when the
 * cached state came from another account).
 */
export async function receiveSentEnvelope(target: Target): Promise<any> {
  const sent: any = await receive(target);
  if (!sent.data || !sent.token) throw new Error('receiveSentEnvelope: invalid response');
  await send(sent.token, { res: 'success' });
  return sent;
}

function canonicalizeJsonString(str: string): string {
  try {
    // Parse the JSON string and re-stringify with sorted keys
    const parsed = JSON.parse(str);
    return JSON.stringify(parsed, Object.keys(parsed).sort());
  } catch (e) {
    // If it's not valid JSON, return as-is
    return str;
  }
}

function deepCanonicalizeJsonStrings(obj: any): any {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  // If this is an array, recursively canonicalize each element
  if (Array.isArray(obj)) {
    return obj.map(deepCanonicalizeJsonStrings);
  }

  // Recursively process nested objects and canonicalize JSON string fields
  const canonicalized: any = {};
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      const value = obj[key];

      if (typeof value === 'string') {
        // Try to canonicalize any string field that looks like JSON
        canonicalized[key] = canonicalizeJsonString(value);
      } else if (value && typeof value === 'object') {
        // Recursively process nested objects/arrays
        canonicalized[key] = deepCanonicalizeJsonStrings(value);
      } else {
        // Keep primitives as-is
        canonicalized[key] = value;
      }
    }
  }
  return canonicalized;
}

// Extracts the human-visible text from a WhatsApp Cloud API send envelope.
function waSentText(data: any): any {
  if (!data) return undefined;
  if (data.type === 'text') return data.text?.body;
  if (data.type === 'interactive') return data.interactive?.body?.text;
  if (data.image) return data.image?.caption;
  if (data.video) return data.video?.caption;
  return undefined;
}

// WhatsApp flow driver. Mirrors flowMaster but (1) asserts against the WhatsApp
// send envelope's visible text (text.body / interactive.body.text) instead of
// data.message, and (2) does NOT synthesize an echo: the WhatsApp send carries
// no metadata to echo, so the message-worker emits the bot_echo itself. The
// snooze lets that worker echo advance the conversation to QOUT before the next
// user answer is sent (both are keyed by userId, so ordering holds once the
// echo is produced).
export async function flowMasterWhatsApp(target: Target, testFlow: TestFlow): Promise<void> {
  for (const [res, get, gives] of testFlow) {
    const sent = await receive(target);
    const { data, token } = sent as any;
    if (!data || !token) throw new Error('Invalid response from receive');

    const sentText = waSentText(data);
    const expected = (get as any).text ?? (get as any).attachment?.payload?.text ?? (get as any).question_text;

    try {
      sentText.should.eql(expected);
      await send(token, res);
    } catch (e) {
      console.log('WA sent:', util.inspect(data, undefined, 8));
      console.log('WA expected text:', expected);
      console.error(e);
      await send(token, { error: { message: 'test broke', code: 99999 } });
      throw e;
    }

    if (!('error' in res)) {
      await snooze(1000); // let the worker-emitted bot_echo advance state to QOUT
    }

    for (const giv of gives) {
      await sendMessage(giv);
    }
  }
}

// Messenger flow driver. Accepts a bare userId (legacy, unscoped) or a
// Conversation handle (account-scoped).
//
// A5 -- THE ECHO MUST CARRY THE CONVERSATION'S ACCOUNT. On every non-error
// interaction this synthesizes an echo of the message it just received, which is
// what arms replybot's WAIT_EXTERNAL_EVENT and advances the flow. `makeEcho`
// stamps the account as `sender.id` (the Messenger echo inversion: on an echo
// the ACCOUNT is the sender and the USER is the recipient). Before A5 this call
// omitted the account entirely, so every echo was attributed to the default page
// -- which in a two-account test would inject account A's echo into account B's
// conversation and corrupt the very state the test is measuring. Getting this
// wrong does not fail loudly; it silently reproduces the bug under test.
export async function flowMaster(target: Target, testFlow: TestFlow): Promise<void> {
  const echoAccount = isConversation(target) ? target.accountId : undefined;

  for (const [res, get, gives, recip] of testFlow) {
    let sent: SentResponse;

    if (recip) {
      sent = await receive(recip);
    } else {
      sent = await receive(target);
    }

    const {data, token} = sent;
    if (!data || !token) throw new Error('Invalid response from receive');

    const msg = data.message;

    try {
      const canonicalizedMsg = deepCanonicalizeJsonStrings(msg);
      const canonicalizedGet = deepCanonicalizeJsonStrings(get);
      canonicalizedMsg.should.eql(canonicalizedGet);
      await send(token, res);
    }
    catch (e) {
      console.log(util.inspect(msg, undefined, 8));
      console.log(util.inspect(get, undefined, 8));
      console.error(e);
      const r: ErrorResponse = { error: { message: 'test broke', code: 99999 }};
      await send(token, r);
      throw e;
    }

    if (!('error' in res)) {
      // Echo on the conversation's OWN account -- see the A5 note above.
      await sendMessage(
        echoAccount
          ? makeEcho(get, userIdOf(target), Date.now(), echoAccount)
          : makeEcho(get, userIdOf(target)),
      );
    }

    for (const giv of gives) {
      await sendMessage(giv);
    }
  }
}

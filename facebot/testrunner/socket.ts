import r2 from 'r2';
import util from 'util';
import { should } from 'chai';
import { makeEcho, Field } from './mox';
import sendMessage from './sender';
import { snooze } from './utils';

should();

const facebotUrl = (): string => process.env.FACEBOT_URL || 'http://gbv-facebot';

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

async function receive(id: string): Promise<SentResponse> {
  while (true) {
    const res = await r2.get(`${facebotUrl()}/sent/${id}`).json;
    if (res.data) {
      return res;
    }
    await snooze(50);
  }
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
export async function receiveSent(userId: string): Promise<any> {
  const sent = await receive(userId);         // { data, token } — data is the full POST body
  if (!sent.data || !sent.token) throw new Error('receiveSent: invalid response');
  await send(sent.token, { res: 'success' });  // MUST ack or the worker's POST times out (10s)
  return sent.data;
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

export async function flowMaster(userId: string, testFlow: TestFlow): Promise<void> {
  for (const [res, get, gives, recip] of testFlow) {
    let sent: SentResponse;

    if (recip) {
      sent = await receive(recip);
    } else {
      sent = await receive(userId);
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
      await sendMessage(makeEcho(get, userId));
    }

    for (const giv of gives) {
      await sendMessage(giv);
    }
  }
} 

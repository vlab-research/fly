import r2 from 'r2';
import util from 'util';
import { should } from 'chai';
import { makeEcho, Field } from '@vlab-research/mox';
import sendMessage from './sender';
import { snooze } from './utils';

should();

const facebot = 'http://gbv-facebot';

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
    const res = await r2.get(`${facebot}/sent/${id}`).json;
    if (res.data) {
      return res;
    }
    await snooze(50);
  }
}

async function send(token: string, json: any): Promise<any> {
  const res = await r2.post(`${facebot}/respond/${token}`, {json}).response;
  return res;
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
      msg.should.eql(get);
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

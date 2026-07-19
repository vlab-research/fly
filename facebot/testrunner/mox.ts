import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

// translate-typeform has no TypeScript types
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { translator, addCustomType } = require('@vlab-research/translate-typeform');

export const PAGE_ID = '935593143497601';

export interface QuickReply {
  content_type: string;
  title?: string;
  payload?: string;
}

export interface Button {
  type: string;
  title: string;
  payload: string;
}

export interface Field {
  metadata?: string;
  text?: string;
  quick_replies?: QuickReply[];
  attachment?: {
    type: string;
    payload: {
      template_type?: string;
      text?: string;
      buttons?: Button[];
      [key: string]: any;
    };
  };
  [key: string]: any;
}

export interface SyntheticEvent {
  type: string;
  value: Record<string, any>;
}

export function fieldsFromForm(form: any): Field[] {
  return form.fields.map(addCustomType).map((f: any) => translator(f).message);
}

export function getFields(path: string): Field[] {
  return fieldsFromForm(JSON.parse(fs.readFileSync(path, 'utf-8')));
}

function baseMessage(userId: string, extra: any, time = Date.now(), pageId = PAGE_ID): any {
  return {
    id: uuidv4(),
    time,
    messaging: [{
      sender: { id: userId },
      recipient: { id: pageId },
      timestamp: time,
      ...extra,
    }],
  };
}

export function makeReferral(userId: string, formId: string, time = Date.now(), pageId = PAGE_ID): any {
  return {
    id: uuidv4(),
    time,
    messaging: [{
      recipient: { id: pageId },
      timestamp: Date.now(),
      sender: { id: userId },
      referral: {
        ref: `form.${formId}`,
        source: 'SHORTLINK',
        type: 'OPEN_THREAD',
      },
    }],
  };
}

export function makeEcho(message: Field, userId: string, time = Date.now(), pageId = PAGE_ID): any {
  const extra = {
    sender: { id: pageId },
    recipient: { id: userId },
    message: {
      is_echo: true,
      metadata: message.metadata,
      text: message.text ?? message.attachment?.payload?.text,
    },
  };
  return baseMessage(userId, extra, time);
}

export function makePostback(message: Field, userId: string, idx: number, time = Date.now(), pageId = PAGE_ID): any {
  if (message.attachment?.payload?.buttons) {
    const button = message.attachment.payload.buttons[idx];
    const postback = { payload: button.payload, title: button.title };
    return baseMessage(userId, { postback }, time, pageId);
  }
  if (message.quick_replies) {
    const payload = message.quick_replies[idx].payload;
    const qr = { quick_reply: { payload } };
    return baseMessage(userId, { message: qr }, time, pageId);
  }
  throw new Error('makePostback: field has neither buttons nor quick_replies');
}

export function makeQR(message: Field, userId: string, idx: number, time = Date.now(), pageId = PAGE_ID): any {
  if (!message.quick_replies) {
    throw new Error('makeQR: field has no quick_replies');
  }
  const payload = message.quick_replies[idx].payload;
  const qr = { quick_reply: { payload } };
  return baseMessage(userId, { message: qr }, time, pageId);
}

export function makeTextResponse(userId: string, text: string, time = Date.now(), pageId = PAGE_ID): any {
  return baseMessage(userId, { message: { text } }, time, pageId);
}

export function makeSynthetic(userId: string, event: SyntheticEvent, pageId = PAGE_ID): any {
  return {
    user: userId,
    source: 'synthetic',
    page: pageId,
    event,
  };
}

export function makeHandover(
  userId: string,
  newOwnerAppId: string,
  previousOwnerAppId: string,
  metadata: Record<string, any>,
  time = Date.now(),
  pageId = PAGE_ID,
): any {
  return baseMessage(userId, {
    pass_thread_control: {
      new_owner_app_id: newOwnerAppId,
      previous_owner_app_id: previousOwnerAppId,
      metadata: JSON.stringify(metadata),
    },
  }, time, pageId);
}

export function makeNotify(userId: string, payload: string, time = Date.now(), pageId = PAGE_ID): any {
  const extra = {
    optin: {
      type: 'one_time_notif_req',
      payload,
      one_time_notif_token: 'FOOBAR',
    },
  };
  return baseMessage(userId, extra, time, pageId);
}

export const _baseMessage = baseMessage;

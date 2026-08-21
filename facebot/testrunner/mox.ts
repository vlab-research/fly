import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { PAGE_A, WHATSAPP_PHONE_NUMBER_ID, ACCOUNT_PLATFORM } from './seed-db';
import { Conversation } from './conversation';

// translate-typeform has no TypeScript types
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { translator, addCustomType } = require('@vlab-research/translate-typeform');

// Alias for backward compatibility. PAGE_A is the default Messenger page;
// existing 40+ tests hardcode this id and rely on it as the default account.
export const PAGE_ID = PAGE_A;

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

// Emit an echo (inversion of sender/recipient). The account parameter MUST be the
// account the conversation is running on. Passing the wrong one stamps the echo with
// the wrong page, which corrupts the very state a two-account test is measuring.
// Tip: prefer makeEchoFor(conv, message, time) to avoid this footgun.
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
  // Note: baseMessage's sender/recipient are overwritten by the spread of extra.
  // The sender here is the PAGE (account), and recipient is the USER (echo inversion).
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

// Emit a synthetic event with the full account envelope.
// The platform is derived from the account id; pass explicitly only if the account
// belongs to an unseen platform (which should not happen in the test suite).
// Keeps 'page' as a deprecated alias.
export function makeSynthetic(userId: string, event: SyntheticEvent, accountId = PAGE_A, platform?: string): any {
  const plat = platform || ACCOUNT_PLATFORM[accountId];
  if (!plat) {
    throw new Error(
      `makeSynthetic: unknown account '${accountId}'. Seeded accounts are: ` +
      Object.keys(ACCOUNT_PLATFORM).join(', ')
    );
  }
  return {
    user: userId,
    source: 'synthetic',
    account_id: accountId,
    page: accountId,
    platform: plat,
    event,
  };
}

// Post a deliberately malformed synthetic body untouched through the synthetic
// routing path (source: 'synthetic'), for testing rejection and accept-but-not-require
// rollout steps. This is how we test that Hermes rejects incomplete events (missing
// account_id or platform), and that the pre-rejection "accept and stamp" phase is
// non-breaking for legacy posters that don't send the fields yet.
export function makeSyntheticRaw(body: any): any {
  return {
    source: 'synthetic',
    ...body,
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

// --- WhatsApp Cloud API webhook builders ---
// These produce the { entry: [ { changes: [ { value: { messages: [...] } } ] } ] }
// shape Hermes' /whatsapp handler consumes, tagged source:'whatsapp' so
// sender.ts routes them there. The account is the seeded phone_number_id.

export const WA_PHONE_NUMBER_ID = WHATSAPP_PHONE_NUMBER_ID;

function waEnvelope(userId: string, message: any, phoneNumberId = WA_PHONE_NUMBER_ID): any {
  return {
    source: 'whatsapp',
    entry: [{
      id: 'WABA_TEST',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
          contacts: [{ profile: { name: 'Tester' }, wa_id: userId }],
          messages: [message],
        },
      }],
    }],
  };
}

export function makeWhatsAppReferral(userId: string, formId: string, time = Date.now(), phoneNumberId = WA_PHONE_NUMBER_ID): any {
  return waEnvelope(userId, {
    from: userId,
    id: uuidv4(),
    timestamp: Math.floor(time / 1000),
    type: 'text',
    text: { body: `start ${formId}` },
    referral: { ref: `form.${formId}`, source: 'ctwa', type: 'OPEN' },
  }, phoneNumberId);
}

export function makeWhatsAppText(userId: string, text: string, time = Date.now(), phoneNumberId = WA_PHONE_NUMBER_ID): any {
  return waEnvelope(userId, {
    from: userId,
    id: uuidv4(),
    timestamp: Math.floor(time / 1000),
    type: 'text',
    text: { body: text },
  }, phoneNumberId);
}

export function makeWhatsAppTextStart(userId: string, formId: string, time = Date.now(), phoneNumberId = WA_PHONE_NUMBER_ID): any {
  return waEnvelope(userId, {
    from: userId,
    id: uuidv4(),
    timestamp: Math.floor(time / 1000),
    type: 'text',
    text: { body: `form.${formId}` },
  }, phoneNumberId);
}

// Answer a multiple-choice field via a WhatsApp interactive reply. The reply
// title must be the field's choice LABEL — the machine validates choice answers
// against labels, and the normalizer maps button_reply.title to payload.value.
export function makeWhatsAppReply(field: Field, userId: string, idx: number, time = Date.now(), phoneNumberId = WA_PHONE_NUMBER_ID): any {
  if (!field.quick_replies) {
    throw new Error('makeWhatsAppReply: field has no quick_replies');
  }
  const qr = field.quick_replies[idx];
  return waEnvelope(userId, {
    from: userId,
    id: uuidv4(),
    timestamp: Math.floor(time / 1000),
    type: 'interactive',
    interactive: {
      type: 'button_reply',
      button_reply: { id: qr.payload || String(idx), title: qr.title || '' },
    },
  }, phoneNumberId);
}

// --- Conversation-aware convenience builders ---
// These dispatch to the appropriate builder (Messenger or WhatsApp) based on
// the conversation's platform. Use these in two-account tests to avoid repeating
// if/else logic on every step.

export function makeReferralFor(conv: Conversation, formId: string, time = Date.now()): any {
  if (conv.platform === 'whatsapp') {
    return makeWhatsAppReferral(conv.userId, formId, time, conv.accountId);
  } else {
    return makeReferral(conv.userId, formId, time, conv.accountId);
  }
}

export function makeTextResponseFor(conv: Conversation, text: string, time = Date.now()): any {
  if (conv.platform === 'whatsapp') {
    return makeWhatsAppText(conv.userId, text, time, conv.accountId);
  } else {
    return makeTextResponse(conv.userId, text, time, conv.accountId);
  }
}

export function makePostbackFor(field: Field, conv: Conversation, idx: number, time = Date.now()): any {
  if (conv.platform === 'whatsapp') {
    return makeWhatsAppReply(field, conv.userId, idx, time, conv.accountId);
  } else {
    return makePostback(field, conv.userId, idx, time, conv.accountId);
  }
}

export function makeQRFor(field: Field, conv: Conversation, idx: number, time = Date.now()): any {
  if (conv.platform === 'whatsapp') {
    return makeWhatsAppReply(field, conv.userId, idx, time, conv.accountId);
  } else {
    return makeQR(field, conv.userId, idx, time, conv.accountId);
  }
}

export function makeEchoFor(message: Field, conv: Conversation, time = Date.now()): any {
  return makeEcho(message, conv.userId, time, conv.accountId);
}

export function makeSyntheticFor(conv: Conversation, event: SyntheticEvent): any {
  return makeSynthetic(conv.userId, event, conv.accountId, conv.platform);
}

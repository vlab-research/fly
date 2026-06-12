"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports._baseMessage = exports.makeNotify = exports.makeSynthetic = exports.makeTextResponse = exports.makeQR = exports.makePostback = exports.makeEcho = exports.makeReferral = exports.getFields = exports.PAGE_ID = void 0;
const fs = __importStar(require("fs"));
const uuid_1 = require("uuid");
// translate-typeform has no TypeScript types
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { translator, addCustomType } = require('@vlab-research/translate-typeform');
exports.PAGE_ID = '935593143497601';
function getFields(path) {
    const form = JSON.parse(fs.readFileSync(path, 'utf-8'));
    return form.fields.map(addCustomType).map((f) => translator(f).message);
}
exports.getFields = getFields;
function baseMessage(userId, extra, time = Date.now(), pageId = exports.PAGE_ID) {
    return {
        id: (0, uuid_1.v4)(),
        time,
        messaging: [{
                sender: { id: userId },
                recipient: { id: pageId },
                timestamp: time,
                ...extra,
            }],
    };
}
function makeReferral(userId, formId, time = Date.now(), pageId = exports.PAGE_ID) {
    return {
        id: (0, uuid_1.v4)(),
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
exports.makeReferral = makeReferral;
function makeEcho(message, userId, time = Date.now(), pageId = exports.PAGE_ID) {
    var _a, _b, _c;
    const extra = {
        sender: { id: pageId },
        recipient: { id: userId },
        message: {
            is_echo: true,
            metadata: message.metadata,
            text: (_a = message.text) !== null && _a !== void 0 ? _a : (_c = (_b = message.attachment) === null || _b === void 0 ? void 0 : _b.payload) === null || _c === void 0 ? void 0 : _c.text,
        },
    };
    return baseMessage(userId, extra, time);
}
exports.makeEcho = makeEcho;
function makePostback(message, userId, idx, time = Date.now(), pageId = exports.PAGE_ID) {
    var _a, _b;
    if ((_b = (_a = message.attachment) === null || _a === void 0 ? void 0 : _a.payload) === null || _b === void 0 ? void 0 : _b.buttons) {
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
exports.makePostback = makePostback;
function makeQR(message, userId, idx, time = Date.now(), pageId = exports.PAGE_ID) {
    if (!message.quick_replies) {
        throw new Error('makeQR: field has no quick_replies');
    }
    const payload = message.quick_replies[idx].payload;
    const qr = { quick_reply: { payload } };
    return baseMessage(userId, { message: qr }, time, pageId);
}
exports.makeQR = makeQR;
function makeTextResponse(userId, text, time = Date.now(), pageId = exports.PAGE_ID) {
    return baseMessage(userId, { message: { text } }, time, pageId);
}
exports.makeTextResponse = makeTextResponse;
function makeSynthetic(userId, event, pageId = exports.PAGE_ID) {
    return {
        user: userId,
        source: 'synthetic',
        page: pageId,
        event,
    };
}
exports.makeSynthetic = makeSynthetic;
function makeNotify(userId, payload, time = Date.now(), pageId = exports.PAGE_ID) {
    const extra = {
        optin: {
            type: 'one_time_notif_req',
            payload,
            one_time_notif_token: 'FOOBAR',
        },
    };
    return baseMessage(userId, extra, time, pageId);
}
exports.makeNotify = makeNotify;
exports._baseMessage = baseMessage;

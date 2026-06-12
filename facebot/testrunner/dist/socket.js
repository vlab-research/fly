"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.flowMaster = void 0;
const r2_1 = __importDefault(require("r2"));
const util_1 = __importDefault(require("util"));
const chai_1 = require("chai");
const mox_1 = require("./mox");
const sender_1 = __importDefault(require("./sender"));
const utils_1 = require("./utils");
(0, chai_1.should)();
const facebotUrl = () => process.env.FACEBOT_URL || 'http://gbv-facebot';
async function receive(id) {
    while (true) {
        const res = await r2_1.default.get(`${facebotUrl()}/sent/${id}`).json;
        if (res.data) {
            return res;
        }
        await (0, utils_1.snooze)(50);
    }
}
async function send(token, json) {
    const res = await r2_1.default.post(`${facebotUrl()}/respond/${token}`, { json }).response;
    return res;
}
async function flowMaster(userId, testFlow) {
    for (const [res, get, gives, recip] of testFlow) {
        let sent;
        if (recip) {
            sent = await receive(recip);
        }
        else {
            sent = await receive(userId);
        }
        const { data, token } = sent;
        if (!data || !token)
            throw new Error('Invalid response from receive');
        const msg = data.message;
        try {
            msg.should.eql(get);
            await send(token, res);
        }
        catch (e) {
            console.log(util_1.default.inspect(msg, undefined, 8));
            console.log(util_1.default.inspect(get, undefined, 8));
            console.error(e);
            const r = { error: { message: 'test broke', code: 99999 } };
            await send(token, r);
            throw e;
        }
        if (!('error' in res)) {
            await (0, sender_1.default)((0, mox_1.makeEcho)(get, userId));
        }
        for (const giv of gives) {
            await (0, sender_1.default)(giv);
        }
    }
}
exports.flowMaster = flowMaster;

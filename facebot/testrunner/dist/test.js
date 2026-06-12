"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/// <reference types="node" />
require("chai");
const mocha_parallel_1 = __importDefault(require("mocha.parallel"));
const sender_1 = __importDefault(require("./sender"));
const mox_1 = require("./mox");
const uuid_1 = require("uuid");
const farmhash_1 = __importDefault(require("farmhash"));
const seed_db_1 = require("./seed-db");
const socket_1 = require("./socket");
const utils_1 = require("./utils");
const responses_1 = require("./responses");
const mustache_1 = __importDefault(require("mustache"));
const fs_1 = __importDefault(require("fs"));
///////////////////////////////////////////////
// SETUP -----------------------------------
const CHATBASE_BACKEND = process.env.CHATBASE_BACKEND || '@vlab-research/chatbase-postgres';
const Chatbase = require(CHATBASE_BACKEND);
const chatbase = new Chatbase();
function makeRepeat(field, text) {
    const ref = JSON.parse(field.metadata || '{}').ref;
    return {
        text: text,
        metadata: JSON.stringify({ repeat: true, ref })
    };
}
function makeRepeated(field) {
    return { ...field, metadata: JSON.stringify({ isRepeat: true, ...JSON.parse(field.metadata || '{}') }) };
}
function makeOff() {
    return {
        message: {
            text: "We're sorry, but this survey is now over and closed."
        },
        metadata: {
            ref: 'off_message'
        }
    };
}
const ok = { res: 'success' };
const err = { error: { message: 'test error', code: 555 } };
const err2 = { error: { message: 'test error', code: -1 } };
function interpolate(str, values) {
    return mustache_1.default.parse(str)
        .map((token) => {
        const [type, value] = token;
        return type === 'name' ? values[value] : value;
    })
        .join('');
}
const get = { text: 'get message' }; // Define get message
///////////////////////////////////////////////
// TESTS -----------------------------------
describe('Test Bot flow Survey Integration Testing', () => {
    before(async () => {
        await (0, seed_db_1.seed)(chatbase);
        console.log('Test starting!');
    });
    after(() => {
        console.log('Test finished!');
    });
    (0, mocha_parallel_1.default)('Basic Functionality', function () {
        this.timeout(45000);
        it('Recieves bailout event and switches forms', async () => {
            const userId = (0, uuid_1.v4)();
            const fieldsA = (0, mox_1.getFields)('forms/v7R942.json');
            const fieldsB = (0, mox_1.getFields)('forms/BhaV5G.json');
            const err = { error: { message: 'test error', code: 555 } };
            const testFlow = [
                [err, fieldsA[0], [(0, mox_1.makeSynthetic)(userId, { type: 'bailout', value: { form: 'BhaV5G' } })]],
                [ok, fieldsB[0], []],
                [ok, fieldsB[1], []],
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'v7R942'));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
        it('Follows logic jumps based on external events: payment success', async () => {
            const userId = (0, uuid_1.v4)();
            const fields = (0, mox_1.getFields)('forms/SNomCIYT.json');
            const testFlow = [
                [ok, fields[0], [(0, mox_1.makeTextResponse)(userId, '+918888000000')]],
                [ok, fields[1], [(0, mox_1.makeQR)(fields[1], userId, 0)]],
                [ok, fields[2], []],
                [ok, fields[5], []],
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'SNomCIYT'));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
        it('Follows logic jumps based on external events: payment failure', async () => {
            const userId = (0, uuid_1.v4)();
            const vals = { 'hidden:e_payment_fake_error_message': 'you fake' };
            const form = fs_1.default.readFileSync('forms/gk3gt9ag.json', 'utf-8');
            const f = interpolate(form, vals);
            fs_1.default.writeFileSync('forms/temp.json', f);
            const fields = (0, mox_1.getFields)('forms/temp.json');
            const testFlow = [
                [ok, fields[0], [(0, mox_1.makeTextResponse)(userId, '+918888000000')]],
                [ok, fields[1], [(0, mox_1.makeQR)(fields[1], userId, 0)]],
                [ok, fields[2], []],
                [ok, fields[3], []],
                [ok, fields[4], [(0, mox_1.makeEcho)(get, userId)]],
                [ok, fields[0], []],
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'gk3gt9ag'));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
        it('Test chat flow with logic jump "Yes"', async () => {
            const userId = (0, uuid_1.v4)();
            const fields = (0, mox_1.getFields)('forms/LDfNCy.json');
            const testFlow = [
                [ok, fields[0], [(0, mox_1.makePostback)(fields[0], userId, 0)]],
                [ok, fields[1], [(0, mox_1.makePostback)(fields[1], userId, 0)]],
                [ok, fields[2], [(0, mox_1.makeTextResponse)(userId, 'LOL')]],
                [ok, fields[4], []],
                [ok, fields[5], []],
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'LDfNCy'));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
        it('Test chat flow with logic jump "No"', async () => {
            const userId = (0, uuid_1.v4)();
            const fields = (0, mox_1.getFields)('forms/LDfNCy.json');
            const testFlow = [
                [ok, fields[0], [(0, mox_1.makePostback)(fields[0], userId, 0)]],
                [ok, fields[1], [(0, mox_1.makePostback)(fields[1], userId, 1)]],
                [ok, fields[3], []],
                [ok, fields[5], []],
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'LDfNCy'));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
        it('Puts user into blocked state when given facebook error', async () => {
            const userId = (0, uuid_1.v4)();
            const fields = (0, mox_1.getFields)('forms/LDfNCy.json');
            const err = { error: { message: 'test error', code: 555 } };
            const testFlow = [
                [err, fields[0], []]
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'LDfNCy'));
            await (0, socket_1.flowMaster)(userId, testFlow);
            // wait for scribble to catch up
            await (0, utils_1.snooze)(8000);
            const state = await (0, responses_1.getState)(chatbase, userId);
            if (!state)
                throw new Error('State not found');
            state.current_state.should.equal('BLOCKED');
            state.fb_error_code.should.equal('555');
        });
        it('Puts user into error state when given a bad form', async () => {
            const userId = (0, uuid_1.v4)();
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'DOESNTEXIST'));
            // wait for scribble to catch up
            await (0, utils_1.snooze)(8000);
            const state = await (0, responses_1.getState)(chatbase, userId);
            if (!state)
                throw new Error('State not found');
            state.current_state.should.equal('ERROR');
            state.state_json.error.tag.should.equal('FORM_NOT_FOUND');
            state.state_json.error.status.should.equal(404);
        });
        it('Test chat flow with logic jump from previous question', async () => {
            const userId = (0, uuid_1.v4)();
            const fields = (0, mox_1.getFields)('forms/jISElk.json');
            const testFlow = [
                [ok, fields[0], [(0, mox_1.makeQR)(fields[0], userId, 1)]],
                [ok, fields[1], [(0, mox_1.makeQR)(fields[1], userId, 5)]],
                [ok, fields[2], [(0, mox_1.makeTextResponse)(userId, 'LOL')]],
                [ok, fields[4], []],
                [ok, fields[5], []],
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'jISElk'));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
        it('Test chat flow logic jump from hidden seed_2 field', async () => {
            const fields = (0, mox_1.getFields)('forms/nFgfNE.json');
            const makeId = () => {
                const uid = (0, uuid_1.v4)();
                const suitable = farmhash_1.default.fingerprint32('nFgfNE' + uid) % 2 === 0;
                return suitable ? uid : makeId();
            };
            const userId = makeId();
            const testFlow = [
                [ok, fields[0], [(0, mox_1.makeQR)(fields[0], userId, 1)]],
                [ok, fields[1], [(0, mox_1.makePostback)(fields[1], userId, 0)]],
                [ok, fields[3], []],
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'nFgfNE'));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
        it('Test chat flow with validation failures', async () => {
            const userId = (0, uuid_1.v4)();
            const fields = (0, mox_1.getFields)('forms/ciX4qo.json');
            const repeatPhone = makeRepeat(fields[0], 'Sorry, please enter a valid phone number.');
            const repeatEmail = makeRepeat(fields[1], 'Sorry, please enter a valid email address.');
            const testFlow = [
                [ok, fields[0], [(0, mox_1.makeTextResponse)(userId, '23345')]],
                [ok, repeatPhone, []],
                [ok, makeRepeated(fields[0]), [(0, mox_1.makeTextResponse)(userId, '+918888000000')]],
                [ok, fields[1], [(0, mox_1.makeTextResponse)(userId, 'foo')]],
                [ok, repeatEmail, []],
                [ok, makeRepeated(fields[1]), [(0, mox_1.makeTextResponse)(userId, 'foo@gmail.com')]],
                [ok, fields[2], []]
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'ciX4qo'));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
        it('Test chat flow with custom validation error messages', async () => {
            const userId = (0, uuid_1.v4)();
            const fields = (0, mox_1.getFields)('forms/KAvzEUWn.json');
            const repeatNumber = makeRepeat(fields[0], 'foo number bar');
            const repeatSelect = makeRepeat(fields[1], '*foo selection bar*');
            const testFlow = [
                [ok, fields[0], [(0, mox_1.makeTextResponse)(userId, 'haha not number')]],
                [ok, repeatNumber, []],
                [ok, makeRepeated(fields[0]), [(0, mox_1.makeTextResponse)(userId, '590')]],
                [ok, fields[1], [(0, mox_1.makeTextResponse)(userId, 'foozzzz')]],
                [ok, repeatSelect, []],
                [ok, makeRepeated(fields[1]), [(0, mox_1.makeQR)(fields[1], userId, 0)]],
                [ok, fields[2], []]
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'KAvzEUWn'));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
        it('Test chat flow with stitched forms: stitches and maintains seed', async () => {
            const makeId = () => {
                const uid = (0, uuid_1.v4)();
                const suitable = farmhash_1.default.fingerprint32('Llu24B' + uid) % 5 === 0;
                return suitable ? uid : makeId();
            };
            const userId = makeId();
            const fieldsA = (0, mox_1.getFields)('forms/Llu24B.json');
            const fieldsB = (0, mox_1.getFields)('forms/tKG55U.json');
            const testFlow = [
                [ok, fieldsA[0], [(0, mox_1.makeTextResponse)(userId, 'LOL')]],
                [ok, fieldsA[1], []],
                [ok, fieldsB[0], [(0, mox_1.makePostback)(fieldsB[0], userId, 0)]],
                [ok, fieldsB[2], []],
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'Llu24B'));
            await (0, socket_1.flowMaster)(userId, testFlow);
            await (0, utils_1.snooze)(8000);
            const res = await (0, responses_1.getResponses)(chatbase, userId);
            res.length.should.equal(2);
            res.map(r => r['response']).should.include('LOL');
            res.map(r => r['response']).should.include('true');
            res.map(r => r['parent_shortcode']).should.eql(['Llu24B', 'Llu24B']);
        });
        it('Test chat flow with stitched forms, does not allow first form to be retaken', async () => {
            const makeId = () => {
                const uid = (0, uuid_1.v4)();
                const suitable = farmhash_1.default.fingerprint32('Llu24B' + uid) % 5 === 0;
                return suitable ? uid : makeId();
            };
            const userId = makeId();
            const fieldsA = (0, mox_1.getFields)('forms/Llu24B.json');
            const fieldsB = (0, mox_1.getFields)('forms/tKG55U.json');
            const testFlow = [
                [ok, fieldsA[0], [(0, mox_1.makeTextResponse)(userId, 'LOL')]],
                [ok, fieldsA[1], []],
                [ok, fieldsB[0], [(0, mox_1.makeReferral)(userId, 'Llu24B')]],
                [ok, makeRepeat(fieldsB[0], "Sorry, that answer is not valid. Please try to answer the question again."), []],
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'Llu24B'));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
        it('Test chat flow - does not allow retaking of forms even after switching', async () => {
            const userId = (0, uuid_1.v4)();
            const fieldsA = (0, mox_1.getFields)('forms/LDfNCy.json');
            const fieldsB = (0, mox_1.getFields)('forms/tKG55U.json');
            const testFlow = [
                [ok, fieldsA[0], [(0, mox_1.makePostback)(fieldsA[0], userId, 0)]],
                [ok, fieldsA[1], [(0, mox_1.makeReferral)(userId, 'tKG55U')]],
                [ok, fieldsB[0], [(0, mox_1.makeReferral)(userId, 'LDfNCy')]],
                [ok, makeRepeat(fieldsB[0], "Sorry, that answer is not valid. Please try to answer the question again."), []],
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'LDfNCy'));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
        it('Test chat flow on forms with translated responses', async () => {
            const userId = (0, uuid_1.v4)();
            const [source, dest] = ['hc2slBXH', 'mzs7qmvZ'];
            const query = `update surveys set translation_conf = jsonb_set(translation_conf, ARRAY['destination'], to_json((select id from surveys where shortcode = $1 limit 1)::STRING)) where shortcode = $2;`;
            await chatbase.pool.query(query, [dest, source]);
            const fields = (0, mox_1.getFields)('forms/hc2slBXH.json');
            const testFlow = [
                [ok, fields[0], [(0, mox_1.makeQR)(fields[0], userId, 0)]],
                [ok, fields[1], [(0, mox_1.makeTextResponse)(userId, 'LOL')]],
                [ok, fields[2], []],
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'hc2slBXH'));
            await (0, socket_1.flowMaster)(userId, testFlow);
            await (0, utils_1.snooze)(8000);
            const res = await (0, responses_1.getResponses)(chatbase, userId);
            res.length.should.equal(2);
            res.map(r => r['response']).should.include('LOL');
            res.map(r => r['response']).should.include('Good');
            res.map(r => r['translated_response']).should.include('LOL');
            res.map(r => r['translated_response']).should.include('Bien');
        });
        it('Test chat flow with multiple links and keepMoving tag', async () => {
            const userId = (0, uuid_1.v4)();
            const fields = (0, mox_1.getFields)('forms/B6cIAn.json');
            const testFlow = [
                [ok, fields[0], []],
                [ok, fields[1], []],
                [ok, fields[2], []]
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'B6cIAn'));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
        it('Waits for external event and continues after event', async () => {
            const userId = (0, uuid_1.v4)();
            const fields = (0, mox_1.getFields)('forms/Ep5wnS.json');
            const testFlow = [
                [ok, fields[0], [(0, mox_1.makePostback)(fields[0], userId, 0)]],
                [ok, fields[1], [(0, mox_1.makeSynthetic)(userId, { type: 'external', value: { type: 'moviehouse:play', id: 164118668 } })]],
                [ok, fields[2], [(0, mox_1.makePostback)(fields[2], userId, 0)]],
                [ok, fields[3], []]
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'Ep5wnS'));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
        it('Works with multiple or clauses - india endline seed_16 bug', async () => {
            const fields = (0, mox_1.getFields)('forms/UGqDwc.json');
            const makeId = () => {
                const uid = (0, uuid_1.v4)();
                const suitable = farmhash_1.default.fingerprint32('UGqDwc' + uid) % 16 === 3;
                return suitable ? uid : makeId();
            };
            const userId = makeId();
            const testFlow = [
                [ok, fields[0], [(0, mox_1.makeQR)(fields[0], userId, 0)]],
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
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'UGqDwc'));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
    });
    (0, mocha_parallel_1.default)('Timeouts', function () {
        this.timeout(180000);
        it('Sends timeout message response when interrupted in a timeout, then waits', async () => {
            const userId = (0, uuid_1.v4)();
            const fields = (0, mox_1.getFields)('forms/vHXzrh.json');
            const testFlow = [
                [ok, fields[0], [(0, mox_1.makeTextResponse)(userId, 'LOL')]],
                [ok, { text: 'Please wait!', metadata: '{"repeat":true,"ref":"bd2b2376-d722-4b51-8e1e-c2000ce6ec55"}' }, []],
                [ok, makeRepeated(fields[0]), []],
                [ok, fields[1], [(0, mox_1.makeTextResponse)(userId, 'LOL')]],
                [ok, fields[2], []],
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'vHXzrh'));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
        it('Sends message after timeout absolute timeout', async () => {
            const userId = (0, uuid_1.v4)();
            const timeoutDate = (new Date(Math.floor(Date.now() / 1000 + 60) * 1000)).toISOString();
            const vals = { 'hidden:timeout_date': timeoutDate };
            const form = fs_1.default.readFileSync('forms/j1sp7ffL.json', 'utf-8');
            const f = interpolate(form, vals);
            fs_1.default.writeFileSync('forms/temp-j1sp7ffL.json', f);
            const fields = (0, mox_1.getFields)('forms/temp-j1sp7ffL.json');
            const testFlow = [
                [ok, fields[0], []],
                [ok, fields[1], [(0, mox_1.makeTextResponse)(userId, 'loved it')]],
                [ok, fields[2], []],
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, `j1sp7ffL.timeout_date.${timeoutDate}`));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
        it('Sends messages with notify token after timeout', async () => {
            const userId = (0, uuid_1.v4)();
            const fields = (0, mox_1.getFields)('forms/dbFwhd.json');
            const testFlow = [
                [ok, fields[0], [(0, mox_1.makeNotify)(userId, '{ "ref": "908088b3-5e9e-4b53-b746-799ac51bc758"}')]],
                [ok, fields[1], []],
                [ok, fields[2], [(0, mox_1.makePostback)(fields[2], userId, 1)]],
                [ok, fields[3], []],
                [ok, fields[4], [(0, mox_1.makeQR)(fields[4], userId, 1)], 'FOOBAR'],
                [ok, fields[5], []],
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'dbFwhd'));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
        it('Sends follow ups when the user does not respond', async () => {
            const userId = (0, uuid_1.v4)();
            const fields = (0, mox_1.getFields)('forms/ulrtpfSQ.json');
            const followUp = makeRepeat(fields[0], 'this is a follow up');
            const testFlow = [
                [ok, fields[0], []],
                [ok, followUp, []],
                [ok, makeRepeated(fields[0]), [(0, mox_1.makeQR)(fields[0], userId, 0)]],
                [ok, fields[1], []],
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'ulrtpfSQ'));
            await (0, socket_1.flowMaster)(userId, testFlow);
        });
        it('Retries sending the message when it fails with a proper code', async () => {
            const userId = (0, uuid_1.v4)();
            const fields = (0, mox_1.getFields)('forms/LDfNCy.json');
            const err = { error: { message: 'test error', code: -1 } };
            const testFlow = [
                [err, fields[0], []],
                [ok, fields[0], [(0, mox_1.makePostback)(fields[0], userId, 0)]],
                [ok, fields[1], [(0, mox_1.makePostback)(fields[1], userId, 0)]],
                [ok, fields[2], [(0, mox_1.makeTextResponse)(userId, 'LOL')]],
                [ok, fields[4], []],
                [ok, fields[5], []],
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'LDfNCy'));
            await (0, socket_1.flowMaster)(userId, testFlow);
            // wait for scribble to catch up
            await (0, utils_1.snooze)(8000);
            const state = await (0, responses_1.getState)(chatbase, userId);
            if (!state)
                throw new Error('State not found');
            state.current_state.should.equal('END');
        });
    });
    (0, mocha_parallel_1.default)('Waits', function () {
        this.timeout(300000);
        it('Retries sending the message only up to a point', async () => {
            const userId = (0, uuid_1.v4)();
            const fields = (0, mox_1.getFields)('forms/LDfNCy.json');
            const err = { error: { message: 'test error', code: -1 } };
            const testFlow = [
                [err, fields[0], []],
                [err, fields[0], []],
                [err, fields[0], []]
            ];
            await (0, sender_1.default)((0, mox_1.makeReferral)(userId, 'LDfNCy'));
            await (0, socket_1.flowMaster)(userId, testFlow);
            // wait for scribble to catch up
            await (0, utils_1.snooze)(8000);
            const state = await (0, responses_1.getState)(chatbase, userId);
            if (!state)
                throw new Error('State not found');
            state.current_state.should.equal('BLOCKED');
        });
    });
});

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const r2_1 = __importDefault(require("r2"));
const sendMessage = async function (message) {
    const BOTSERVER_URL = process.env.BOTSERVER_URL || 'http://localhost:3000';
    let json;
    let url;
    const { source } = message;
    switch (source) {
        case 'synthetic':
            url = `${BOTSERVER_URL}/synthetic`;
            json = message;
            break;
        default:
            url = `${BOTSERVER_URL}/webhooks`;
            json = { entry: [message] };
    }
    const res = await r2_1.default.post(url, { json }).response;
    if (res.body && res.body.error) {
        throw new Error(res.body.error);
    }
    return res;
};
exports.default = sendMessage;

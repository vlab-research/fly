"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.waitFor = exports.snooze = void 0;
/// <reference lib="dom" />
const snooze = (ms) => new Promise(resolve => setTimeout(resolve, ms));
exports.snooze = snooze;
async function waitFor(fn, timeout = 30000, interval = 200) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const result = await fn();
        if (result)
            return result;
        await (0, exports.snooze)(interval);
    }
    throw new Error(`waitFor timed out after ${timeout}ms`);
}
exports.waitFor = waitFor;

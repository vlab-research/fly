"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getState = exports.getResponses = void 0;
async function getResponses(chatbase, userid) {
    const { rows } = await chatbase.pool.query('SELECT * FROM responses WHERE userid=$1 ORDER BY timestamp ASC', [userid]);
    return rows;
}
exports.getResponses = getResponses;
async function getState(chatbase, userid) {
    const { rows } = await chatbase.pool.query('SELECT * FROM states WHERE userid=$1', [userid]);
    return rows[0];
}
exports.getState = getState;

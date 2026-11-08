'use strict';

/*
 * The number-health read and registration wired to the real credential
 * queries and Graph client, built once and shared by the REST route and the
 * MCP layer.
 */

const { randomInt } = require('crypto');
const { Credential } = require('../../queries');
const { facebookNumberHealth, facebookRegisterNumber } = require('./whatsapp.facebook');
const { makeNumberHealth, makeRegisterNumber } = require('./whatsapp.service');

/*
 * A number's registration PIN is its own credentials row, keyed like the
 * number's whatsapp_business row, so replacing that row's details (token
 * rotation) cannot lose the PIN Meta now expects. Stored as Fly stores the
 * token beside it; see documentation/agent-api.md §6.
 */
const PIN_ENTITY = 'whatsapp_registration_pin';

const pinStore = {
  async get({ email, phoneNumberId }) {
    const row = await Credential.getOne({ email, entity: PIN_ENTITY, key: phoneNumberId });
    return row && row.details && row.details.pin;
  },
  createIfAbsent({ email, phoneNumberId, pin }) {
    return Credential.createIfAbsent({ entity: PIN_ENTITY, key: phoneNumberId, details: { pin }, email });
  },
};

module.exports = {
  PIN_ENTITY,
  numberHealth: makeNumberHealth({
    listAccounts: Credential.getMessagingAccounts,
    healthClient: facebookNumberHealth,
  }),
  registerNumber: makeRegisterNumber({
    listAccounts: Credential.getMessagingAccounts,
    healthClient: facebookNumberHealth,
    registerClient: facebookRegisterNumber,
    pinStore,
    randomInt,
  }),
};

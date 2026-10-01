'use strict';

/*
 * The number-health read wired to the real credential query and Graph client,
 * built once and shared by the REST route and the MCP layer.
 */

const { Credential } = require('../../queries');
const { facebookNumberHealth } = require('./whatsapp.facebook');
const { makeNumberHealth } = require('./whatsapp.service');

module.exports = {
  numberHealth: makeNumberHealth({
    listAccounts: Credential.getMessagingAccounts,
    healthClient: facebookNumberHealth,
  }),
};

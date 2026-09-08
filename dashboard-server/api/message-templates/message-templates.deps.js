'use strict';

/*
 * The real dependencies of the message-templates service, built once and
 * shared by the REST routes and the MCP layer, so the two cannot be wired to
 * different clients.
 */

const { Credential, MessageTemplate } = require('../../queries');
const {
  facebookCreateTemplate,
  facebookGetTemplatesByName,
  facebookDeleteTemplateByHsmId,
  whatsappCreateTemplate,
  whatsappGetTemplatesByName,
  whatsappDeleteTemplateByHsmId,
} = require('./message-templates.facebook');

module.exports = {
  credentialQuery: Credential,
  templateQuery: MessageTemplate,
  facebookClient: {
    createTemplate: facebookCreateTemplate,
    getTemplatesByName: facebookGetTemplatesByName,
    deleteTemplateByHsmId: facebookDeleteTemplateByHsmId,
  },
  whatsappClient: {
    createTemplate: whatsappCreateTemplate,
    getTemplatesByName: whatsappGetTemplatesByName,
    deleteTemplateByHsmId: whatsappDeleteTemplateByHsmId,
  },
};

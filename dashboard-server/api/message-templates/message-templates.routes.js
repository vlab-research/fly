'use strict';

const router = require('express').Router();
const { Credential, MessageTemplate } = require('../../queries');
const { makeHandlers } = require('./message-templates.controller');
const {
  facebookCreateTemplate,
  facebookGetTemplatesByName,
  facebookDeleteTemplateByHsmId,
} = require('./message-templates.facebook');

const handlers = makeHandlers({
  credentialQuery: Credential,
  templateQuery: MessageTemplate,
  facebookClient: {
    createTemplate: facebookCreateTemplate,
    getTemplatesByName: facebookGetTemplatesByName,
    deleteTemplateByHsmId: facebookDeleteTemplateByHsmId,
  },
});

router
  .post('/', handlers.create)
  .get('/', handlers.list)
  .get('/:id', handlers.getOne)
  .delete('/:id', handlers.remove);

module.exports = router;

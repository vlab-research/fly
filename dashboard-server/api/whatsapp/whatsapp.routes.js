'use strict';

const router = require('express').Router();
const { makeHandlers } = require('./whatsapp.controller');
const { facebookExchangeCode, facebookSubscribeWaba } = require('./whatsapp.facebook');

// Wire real IO dependencies into the controller
const handlers = makeHandlers({
  facebookClient: facebookExchangeCode,
  subscribeClient: facebookSubscribeWaba,
});

router.post('/exchange-code', handlers.exchangeCode);

module.exports = router;

'use strict';

const router = require('express').Router();
const { makeHandlers } = require('./whatsapp.controller');
const { facebookExchangeCode, facebookSubscribeWaba } = require('./whatsapp.facebook');
const { numberHealth } = require('./whatsapp.deps');

// Wire real IO dependencies into the controller
const handlers = makeHandlers({
  facebookClient: facebookExchangeCode,
  subscribeClient: facebookSubscribeWaba,
  numberHealth,
});

router.post('/exchange-code', handlers.exchangeCode);
router.get('/health', handlers.getNumberHealth);

module.exports = router;

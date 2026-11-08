'use strict';

const router = require('express').Router();
const { makeHandlers } = require('./whatsapp.controller');
const { facebookExchangeCode, facebookSubscribeWaba } = require('./whatsapp.facebook');
const { numberHealth, registerNumber } = require('./whatsapp.deps');

// Wire real IO dependencies into the controller
const handlers = makeHandlers({
  facebookClient: facebookExchangeCode,
  subscribeClient: facebookSubscribeWaba,
  numberHealth,
  registerNumber,
});

router.post('/exchange-code', handlers.exchangeCode);
router.get('/health', handlers.getNumberHealth);
router.post('/register', handlers.postRegisterNumber);

module.exports = router;

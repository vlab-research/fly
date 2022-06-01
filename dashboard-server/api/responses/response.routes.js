const router = require('express').Router();
const controller = require('./response.controller');

router
  .get('/first-and-last', controller.getFirstAndLast)
  .get('/form-data', controller.getFormDataCSV)
  .get('/csv', controller.getResponsesCSV);

module.exports = router;

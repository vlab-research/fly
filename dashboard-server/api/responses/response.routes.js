const router = require('express').Router();
const controller = require('./response.controller');

router
  .get('/', controller.getFirstAndLast)
  .get('/all', controller.getAll)
  .get('/form-data', controller.getFormDataCSV)
  .get('/csv', controller.getResponsesCSV);

module.exports = router;

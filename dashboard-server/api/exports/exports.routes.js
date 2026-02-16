const router = require('express').Router();
const controller = require('./exports.controller');

router
  .post('/', controller.generateExport)
  .get('/status', controller.getAll)
  .get('/status/survey', controller.getBySurvey);

module.exports = router;

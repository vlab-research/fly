const router = require('express').Router();
const controller = require('./exports.controller');

router
  .get('/', controller.generateExport)
  .get('/status', controller.getAll);

module.exports = router;

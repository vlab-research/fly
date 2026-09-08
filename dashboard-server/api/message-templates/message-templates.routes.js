'use strict';

const router = require('express').Router();
const { makeHandlers } = require('./message-templates.controller');
const deps = require('./message-templates.deps');

const handlers = makeHandlers(deps);

router
  .post('/', handlers.create)
  .get('/', handlers.list)
  .get('/:id', handlers.getOne)
  .delete('/:id', handlers.remove);

module.exports = router;

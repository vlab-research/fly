'use strict';

const router = require('express').Router();
const { makeHandlers } = require('./tickets.controller');
const { makeClient } = require('../../utils/linear/linear.util');
const { LINEAR } = require('../../config');

const linearClient = makeClient({
  apiKey: LINEAR.apiKey,
  url: LINEAR.url,
  teamId: LINEAR.teamId,
});

const handlers = makeHandlers({
  linearClient,
  apiKey: LINEAR.apiKey,
  teamId: LINEAR.teamId,
  todoStateId: LINEAR.todoStateId,
});

router
  .get('/', handlers.list)
  .post('/', handlers.create)
  .get('/:id', handlers.getOne)
  .post('/:id/replies', handlers.reply);

module.exports = router;

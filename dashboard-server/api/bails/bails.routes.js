const router = require('express').Router({ mergeParams: true });
const controller = require('./bails.controller');

// All routes are prefixed with /users/:userId/bails
// User access is validated by middleware on all routes

router.use(controller.validateUserAccess);

router
  .get('/', controller.listBails)
  .post('/', controller.createBail)
  .post('/preview', controller.previewBail)
  .get('/:bailId', controller.getBail)
  .put('/:bailId', controller.updateBail)
  .delete('/:bailId', controller.deleteBail)
  .get('/:bailId/events', controller.getBailEvents);

module.exports = router;

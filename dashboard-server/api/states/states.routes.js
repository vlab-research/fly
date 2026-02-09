const router = require('express').Router({ mergeParams: true });
const controller = require('./states.controller');

// All routes are prefixed with /surveys/:surveyName/states
// Survey access is validated by middleware

router.use(controller.validateSurveyNameAccess);

router
  .get('/summary', controller.getSummary)
  .get('/', controller.listStates)
  .get('/:userid', controller.getStateDetail);

module.exports = router;

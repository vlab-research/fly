const router = require('express').Router();
const bailsController = require('./bails/bails.controller');

router
  .use('/responses', require('./responses'))
  .use('/exports', require('./exports'))
  .use('/users', require('./users'))
  .use('/surveys', require('./surveys'))
  .use('/typeform', require('./typeform'))
  .use('/credentials', require('./credentials'))
  .use('/facebook', require('./facebook'))
  .use('/auth', require('./auth/auth.routes'))
  .use('/surveys/:surveyId/bails', require('./bails'))
  .use('/surveys/:surveyName/states', require('./states'))
  .get('/surveys/:surveyId/bail-events', bailsController.validateSurveyAccess, bailsController.getSurveyEvents);

module.exports = router;

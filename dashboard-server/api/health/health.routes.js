const router = require('express').Router({ mergeParams: true });
const controller = require('./health.controller');
const { validateSurveyNameAccess } = require('../states/states.controller');

// Mounted at /surveys/:surveyName/health — same ownership validation and
// shortcode collection as the states routes.
router.use(validateSurveyNameAccess);

router.get('/', controller.getHealth);

module.exports = router;

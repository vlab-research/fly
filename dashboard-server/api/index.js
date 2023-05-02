const router = require('express').Router();

router
  .use('/responses', require('./responses'))
  .use('/exports', require('./exports'))
  .use('/users', require('./users'))
  .use('/surveys', require('./surveys'))
  .use('/typeform', require('./typeform'))
  .use('/credentials', require('./credentials'))
  .use('/facebook', require('./facebook'))
  .use('/auth', require('./auth/auth.routes'));

module.exports = router;

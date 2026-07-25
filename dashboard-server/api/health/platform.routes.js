const router = require('express').Router();
const controller = require('./health.controller');

// Mounted at /platform. Auth applies via the server-level middleware; no
// survey scoping — platform notices apply to every researcher.
router.get('/notices', controller.getPlatformNotices);

module.exports = router;

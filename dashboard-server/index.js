'use strict';

const CubejsServerCore = require('@cubejs-backend/server-core');
const http = require('http');
const app = require('./server');
const auth = require('./middleware/auth');

const options = {
  devServer: false,
  checkAuthMiddleware: auth,
};

CubejsServerCore.create(options).initApp(app);

http.createServer(app).listen(3000);

var { randomBytes } = require('crypto');
var express = require('express');
var nock = require('nock');
var got = require('got');
var {
  expect, 
  fail,
} = require('chai');
var { createJwt } = require('../utils/test-jwt/helpers.jwt');
var {
  auth,
  claimCheck,
  claimEquals,
  claimIncludes,
  requiredScopes,
  UnauthorizedError,
  InvalidRequestError,
  InvalidTokenError,
  InsufficientScopeError,
} = require('express-oauth2-jwt-bearer');

const expectFailsWith = async function (
  promise,
  status,
  code,
  description,
  scopes
) {
  try {
    await promise;
    fail('Request should fail');
  } catch (e) {
    const error = code ? `, error="${code}"` : '';
    const errorDescription = description
      ? `, error_description="${description}"`
      : '';
    expect(e.response.statusCode).to.equal(status);
    expect(e.response.headers['www-authenticate']).to.equal(
      `Bearer realm="api"${error}${errorDescription}${
        (scopes && ', scope="' + scopes + '"') || ''
      }`
    );
  }
};

describe('index', () => {
  let server;

  afterEach((done) => {
    nock.cleanAll();
    (server && server.listening && server.close(done)) || done();
  });

  const setup = (
    opts = {}
  ) => {
    const app = express();
    const { middleware, ...authOpts } = opts;
    app.use(express.urlencoded({ extended: false }));

    app.use(
      auth({
        issuerBaseURL: 'https://issuer.example.com/',
        audience: 'https://api/',
        ...authOpts,
      })
    );

    if (middleware) {
      app.use(middleware);
    }

    app.all('/', (req, res, next) => {
      try {
        res.json(req.auth);
        next();
      } catch (e) {
        next(e);
      }
    });

    return new Promise((resolve) => {
      server = app.listen(0, () =>
        resolve(`http://localhost:${(server.address()).port}`)
      );
    });
  };

  it('should fail for anonymous requests', async () => {
    const baseUrl = await setup();
    await expectFailsWith(got(baseUrl), 401);
  });

  it('should succeed for authenticated requests', async () => {
    const jwt = await createJwt();
    const baseUrl = await setup();
    const response = await got(baseUrl, {
      headers: { authorization: `Bearer ${jwt}` },
      responseType: 'json',
    });
    expect(response.statusCode).to.equal(200);
    expect(response.body).to.haveOwnProperty(
      'payload'
    );
    expect(response.body.payload).to.haveOwnProperty(
      'iss', 'https://issuer.example.com/'
    );
  });

  it('should succeed for authenticated requests signed with symmetric keys', async () => {
    const secret = randomBytes(32).toString('hex');
    const jwt = await createJwt({ secret });
    const baseUrl = await setup({
      secret,
      tokenSigningAlg: 'HS256',
    });
    const response = await got(baseUrl, {
      headers: { authorization: `Bearer ${jwt}` },
      responseType: 'json',
    });
    expect(response.statusCode).to.equal(200);
    expect(response.body).to.haveOwnProperty(
      'payload'
    );
    expect(response.body.payload).to.haveOwnProperty(
      'iss', 'https://issuer.example.com/'
    );
  });

  it('should fail for requests signed with invalid symmetric keys', async () => {
    const jwt = await createJwt({ secret: randomBytes(32).toString('hex') });
    const baseUrl = await setup({
      secret: randomBytes(32).toString('hex'),
      tokenSigningAlg: 'HS256',
    });
    await expectFailsWith(
      got(baseUrl, {
        headers: {
          authorization: `Bearer ${jwt}`,
        },
        responseType: 'json',
      }),
      401,
      'invalid_token',
      'signature verification failed'
    );
  });

  it('should fail for audience mismatch', async () => {
    const jwt = await createJwt({ audience: 'bar' });
    const baseUrl = await setup({
      audience: 'foo',
    });
    await expectFailsWith(
      got(baseUrl, {
        headers: {
          authorization: `Bearer ${jwt}`,
        },
        responseType: 'json',
      }),
      401,
      'invalid_token',
      `Unexpected 'aud' value`
    );
  });

  it('should fail when custom validator fails', async () => {
    const jwt = await createJwt();
    const baseUrl = await setup({
      validators: {
        foo: () => false,
      },
    });
    await expectFailsWith(
      got(baseUrl, {
        headers: {
          authorization: `Bearer ${jwt}`,
        },
        responseType: 'json',
      }),
      401,
      'invalid_token',
      `Unexpected 'foo' value`
    );
  });

  it('should succeed for POST requests with custom character encoding', async () => {
    const jwt = await createJwt();
    const baseUrl = await setup();
    const response = await got(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      form: { access_token: jwt },
      responseType: 'json',
    });
    expect(response.statusCode).to.equal(200);
  });

  it('should fail with custom claim check for anonymous request', async () => {
    const app = express();
    app.use(claimCheck(() => false));
    const baseUrl = await new Promise((resolve) => {
      server = app.listen(0, () =>
        resolve(`http://localhost:${(server.address()).port}`)
      );
    });
    try {
      await got(baseUrl);
    } catch ({ response }) {
      expect(response.statusCode).to.equal(401);
      expect(response.headers).to.haveOwnProperty(
        'www-authenticate'
      );
    }
  });

  it('should fail when custom claim check returns false', async () => {
    const jwt = await createJwt({ payload: { num: 2 } });
    const baseUrl = await setup({
      middleware: claimCheck(
        ({ num }) => typeof num === 'number' && num > 3,
        "'num' too small"
      ),
    });
    await expectFailsWith(
      got(baseUrl, {
        headers: {
          authorization: `Bearer ${jwt}`,
        },
        responseType: 'json',
      }),
      401,
      'invalid_token',
      "'num' too small"
    );
  });

  it('should succeed when custom claim check returns true', async () => {
    const jwt = await createJwt({ payload: { num: 4 } });
    const baseUrl = await setup({
      middleware: claimCheck(
        ({ num }) => typeof num === 'number' && num > 3,
        '"num" too small'
      ),
    });
    const response = await got(baseUrl, {
      headers: { authorization: `Bearer ${jwt}` },
      responseType: 'json',
    });
    expect(response.statusCode).to.equal(200);
    expect(response.body).to.haveOwnProperty(
      'payload'
    );
    expect(response.body.payload).to.haveOwnProperty(
      'num', 4
    );
  });

  it('should fail when actual claim does not equal expected claim', async () => {
    const jwt = await createJwt({ payload: { foo: 'baz' } });
    const baseUrl = await setup({ middleware: claimEquals('foo', 'bar') });
    await expectFailsWith(
      got(baseUrl, {
        headers: {
          authorization: `Bearer ${jwt}`,
        },
        responseType: 'json',
      }),
      401,
      'invalid_token',
      "Unexpected 'foo' value"
    );
  });

  it('should succeed when actual claim does equals expected claim', async () => {
    const jwt = await createJwt({ payload: { foo: 'bar' } });
    const baseUrl = await setup({ middleware: claimEquals('foo', 'bar') });
    const response = await got(baseUrl, {
      headers: { authorization: `Bearer ${jwt}` },
      responseType: 'json',
    });
    expect(response.statusCode).to.equal(200);
    expect(response.body).to.haveOwnProperty(
      'payload'
    );
    expect(response.body.payload).to.haveOwnProperty(
      'foo', 'bar'
    );
  });

  it('should fail when actual claim does not include expected claims', async () => {
    const jwt = await createJwt({ payload: { foo: 'bar qux' } });
    const baseUrl = await setup({
      middleware: claimIncludes('foo', 'bar', 'baz'),
    });
    await expectFailsWith(
      got(baseUrl, {
        headers: {
          authorization: `Bearer ${jwt}`,
        },
        responseType: 'json',
      }),
      401,
      'invalid_token',
      "Unexpected 'foo' value"
    );
  });

  it('should succeed when actual claim includes expected claims', async () => {
    const jwt = await createJwt({ payload: { foo: ['bar', 'baz'] } });
    const baseUrl = await setup({
      middleware: claimIncludes('foo', 'bar', 'baz'),
    });
    const response = await got(baseUrl, {
      headers: { authorization: `Bearer ${jwt}` },
      responseType: 'json',
    });
    expect(response.statusCode).to.equal(200);
    expect(response.body).to.haveOwnProperty(
      'payload'
    );
    expect(response.body.payload).to.haveOwnProperty(
      'foo'
    );
  });

  it('should fail when required scopes are not included', async () => {
    const jwt = await createJwt({ payload: { scope: 'foo bar' } });
    const baseUrl = await setup({
      middleware: requiredScopes(['foo', 'bar', 'baz']),
    });
    await expectFailsWith(
      got(baseUrl, {
        headers: {
          authorization: `Bearer ${jwt}`,
        },
        responseType: 'json',
      }),
      403,
      'insufficient_scope',
      'Insufficient Scope',
      'foo bar baz'
    );
  });

  it('should succeed when required scopes are included', async () => {
    const jwt = await createJwt({ payload: { scope: ['foo', 'bar', 'baz'] } });
    const baseUrl = await setup({
      middleware: requiredScopes('foo bar'),
    });
    const response = await got(baseUrl, {
      headers: { authorization: `Bearer ${jwt}` },
      responseType: 'json',
    });
    expect(response.statusCode).to.equal(200);
    expect(response.body).to.haveOwnProperty(
      'payload'
    );
    expect(response.body.payload).to.haveOwnProperty(
      'scope'
    );
  });

  it('should replace double quotes in header with single quotes', async () => {
    const jwt = await createJwt({ payload: { nbf: false } });
    const baseUrl = await setup();
    await expectFailsWith(
      got(baseUrl, {
        headers: {
          authorization: `Bearer ${jwt}`,
        },
        responseType: 'json',
      }),
      401,
      'invalid_token',
      "'nbf' claim must be a number"
    );
  });

  it('should export errors', () => {
    expect(() => {
      throw new UnauthorizedError();
    }).to.throw(UnauthorizedError);
    expect(() => {
      throw new InvalidRequestError();
    }).to.throw(InvalidRequestError);
    expect(() => {
      throw new InvalidTokenError();
    }).to.throw(InvalidTokenError);
    expect(() => {
      throw new InsufficientScopeError();
    }).to.throw(InsufficientScopeError);
  });
});
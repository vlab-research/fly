const nock = require('nock')
const mocha = require('mocha')
const chai = require('chai')
const should = chai.should()

process.env.FACEBOOK_BASE_RETRY_TIME = 1

const m = require('./index')

const BASE_URL = "https://graph.facebook.com"
const V = "v8.0"

describe('getUserInfo', () => {
  it('should catch error if there is a response with an error from Facebook and return default', async () => {
    let error;

    nock(BASE_URL)
      .get(`/${V}/foo?fields=id,name,first_name,last_name`)
      .reply(401, { error: { code: 5 } });


    const res = await m.getUserInfo('foo', 'token')
    res.name.should.equal('_')
  })
})

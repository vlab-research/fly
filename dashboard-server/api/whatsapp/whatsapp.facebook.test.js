'use strict';

const chai = require('chai');
chai.should();
const proxyquire = require('proxyquire');

describe('whatsapp.facebook: facebookRegisterNumber', () => {
  function load(post) {
    return proxyquire('./whatsapp.facebook', {
      r2: { post, '@noCallThru': true },
      '../../config': { FACEBOOK: { url: 'https://graph.example/v25.0' }, '@noCallThru': true },
    });
  }

  it('POSTs the PIN to /{phone_number_id}/register with the number\'s token', async () => {
    let seen;
    const { facebookRegisterNumber } = load((url, opts) => { seen = { url, opts }; return { json: Promise.resolve({ success: true }) }; });

    (await facebookRegisterNumber('1368266703029944', '012345', 'TOKEN')).should.deep.equal({ success: true });
    seen.url.should.equal('https://graph.example/v25.0/1368266703029944/register?access_token=TOKEN');
    seen.opts.should.deep.equal({ json: { messaging_product: 'whatsapp', pin: '012345' } });
  });

  it('redacts the token from a network error', async () => {
    const { facebookRegisterNumber } = load(url => ({ json: Promise.reject(new Error(`request to ${url} failed`)) }));
    let thrown;
    try { await facebookRegisterNumber('w1', '012345', 'TOKEN'); } catch (e) { thrown = e; }

    thrown.message.should.include('access_token=REDACTED');
    thrown.message.should.not.include('TOKEN');
  });
});

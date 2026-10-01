'use strict';

const chai = require('chai');
chai.should();
const { makeNumberHealth } = require('./whatsapp.service');

describe('whatsapp.service: makeNumberHealth', () => {
  const ROWS = [
    { entity: 'whatsapp_business', key: 'w1', details: { access_token: 'SECRET1', waba_id: 'a' } },
    { entity: 'whatsapp_business', key: 'w2', details: { access_token: 'SECRET2', waba_id: 'b' } },
  ];

  function make(healthClient) {
    const seen = [];
    const numberHealth = makeNumberHealth({
      listAccounts: async ({ email }) => { seen.push(email); return ROWS; },
      healthClient: async (id, token) => { seen.push([id, token]); return healthClient(id, token); },
    });
    return { numberHealth, seen };
  }

  it('reads each number with its own token, scoped by the caller\'s email', async () => {
    const { numberHealth, seen } = make(async id => ({ quality_rating: id === 'w1' ? 'GREEN' : 'RED' }));
    const result = await numberHealth({ email: 'me@x.org' });
    seen.should.deep.equal(['me@x.org', ['w1', 'SECRET1'], ['w2', 'SECRET2']]);
    result.numbers.map(n => n.quality_rating).should.deep.equal(['GREEN', 'RED']);
  });

  it('returns no token or credential detail anywhere', async () => {
    const { numberHealth } = make(async () => ({ quality_rating: 'GREEN', access_token: 'ECHO' }));
    const text = JSON.stringify(await numberHealth({ email: 'me@x.org' }));
    ['SECRET', 'ECHO', 'access_token', 'waba_id'].forEach(word => text.should.not.include(word));
  });

  it('calls Meta for nothing when an id is not the caller\'s', async () => {
    const { numberHealth, seen } = make(async () => ({}));
    const result = await numberHealth({ email: 'me@x.org', phoneNumberIds: ['w9'] });
    result.ok.should.equal(false);
    seen.should.deep.equal(['me@x.org']);
  });
});

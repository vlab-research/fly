'use strict';

const chai = require('chai');
chai.should();
const { makeNumberHealth, makeRegisterNumber } = require('./whatsapp.service');

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

describe('whatsapp.service: makeRegisterNumber', () => {
  const ROWS = [
    { entity: 'whatsapp_business', key: 'w1', details: { access_token: 'SECRET1', waba_id: 'a' } },
  ];
  const UNREGISTERED = {
    status: 'PENDING',
    health_status: { can_send_message: 'BLOCKED', entities: [{ entity_type: 'PHONE_NUMBER', id: 'w1',
      errors: [{ error_code: 141000, error_description: 'not linked' }] }] },
  };
  const CONNECTED = { status: 'CONNECTED', health_status: { can_send_message: 'AVAILABLE', entities: [] } };

  // A PIN store keyed by phone_number_id, as the credentials table is: one
  // row per (entity, key) and createIfAbsent never overwrites.
  function memoryPinStore(initial = {}) {
    const rows = { ...initial };
    return {
      rows,
      async get({ email, phoneNumberId }) {
        const row = rows[phoneNumberId];
        return row && row.email === email ? row.pin : undefined;
      },
      async createIfAbsent({ email, phoneNumberId, pin }) {
        if (!rows[phoneNumberId]) rows[phoneNumberId] = { email, pin };
      },
    };
  }

  function make({ health = [UNREGISTERED, CONNECTED], register = { success: true }, pinStore = memoryPinStore(),
    random = [123456] } = {}) {
    const calls = { health: [], register: [], random: 0 };
    const healthAnswers = [...health];
    const registerNumber = makeRegisterNumber({
      listAccounts: async () => ROWS,
      healthClient: async (id, token) => {
        calls.health.push([id, token]);
        return healthAnswers.length > 1 ? healthAnswers.shift() : healthAnswers[0];
      },
      registerClient: async (id, pin, token) => { calls.register.push([id, pin, token]); return register; },
      pinStore,
      randomInt: () => random[calls.random++],
    });
    return { registerNumber, calls, pinStore };
  }

  it('registers an unregistered number with a new PIN and returns the health read after', async () => {
    const { registerNumber, calls, pinStore } = make();
    const result = await registerNumber({ email: 'me@x.org', phoneNumberId: 'w1' });

    calls.register.should.deep.equal([['w1', '123456', 'SECRET1']]);
    pinStore.rows.w1.should.deep.equal({ email: 'me@x.org', pin: '123456' });
    result.registration.should.equal('registered');
    (result.registration_error === null).should.equal(true);
    result.number.status.should.equal('CONNECTED');
    calls.health.should.have.lengthOf(2);
  });

  it('generates the PIN once and reuses it on every later registration', async () => {
    const pinStore = memoryPinStore();
    const first = make({ pinStore, health: [UNREGISTERED], random: [111111] });
    await first.registerNumber({ email: 'me@x.org', phoneNumberId: 'w1' });
    const second = make({ pinStore, health: [UNREGISTERED], random: [222222] });
    await second.registerNumber({ email: 'me@x.org', phoneNumberId: 'w1' });

    first.calls.register[0][1].should.equal('111111');
    second.calls.register[0][1].should.equal('111111');
    second.calls.random.should.equal(0);
  });

  it('uses the PIN that won when another registration stored one first', async () => {
    const pinStore = memoryPinStore();
    const realGet = pinStore.get;
    let first = true;
    pinStore.get = async args => {
      if (first) { first = false; pinStore.rows.w1 = { email: 'me@x.org', pin: '999999' }; return undefined; }
      return realGet(args);
    };
    const { registerNumber, calls } = make({ pinStore, random: [111111] });
    await registerNumber({ email: 'me@x.org', phoneNumberId: 'w1' });
    calls.register[0][1].should.equal('999999');
  });

  it('does not register a number that is already CONNECTED, and creates no PIN', async () => {
    const { registerNumber, calls, pinStore } = make({ health: [CONNECTED] });
    const result = await registerNumber({ email: 'me@x.org', phoneNumberId: 'w1' });

    result.registration.should.equal('already_registered');
    calls.register.should.have.lengthOf(0);
    calls.random.should.equal(0);
    pinStore.rows.should.deep.equal({});
  });

  it('reports Meta\'s refusal with the health read after it', async () => {
    const { registerNumber } = make({
      health: [UNREGISTERED],
      register: { error: { code: 133005, message: 'Two step verification PIN Mismatch' } },
    });
    const result = await registerNumber({ email: 'me@x.org', phoneNumberId: 'w1' });

    result.registration.should.equal('failed');
    result.registration_error.should.deep.equal({ code: 133005, message: 'Two step verification PIN Mismatch' });
    result.number.status.should.equal('PENDING');
  });

  it('attempts nothing when the health read fails', async () => {
    const { registerNumber, calls } = make({ health: [{ error: { code: 190, message: 'Session expired' } }] });
    const result = await registerNumber({ email: 'me@x.org', phoneNumberId: 'w1' });

    result.registration.should.equal('health_unreadable');
    result.registration_error.code.should.equal(190);
    calls.register.should.have.lengthOf(0);
  });

  it('calls Meta for nothing when the number is not the caller\'s', async () => {
    const { registerNumber, calls, pinStore } = make();
    const result = await registerNumber({ email: 'me@x.org', phoneNumberId: 'w9' });

    result.should.deep.equal({
      ok: false,
      error: 'No WhatsApp number connected to your account with phone_number_id w9',
      known: ['w1'],
    });
    calls.health.should.have.lengthOf(0);
    pinStore.rows.should.deep.equal({});
  });

  it('fails loudly when no PIN can be stored for the caller', async () => {
    const pinStore = memoryPinStore({ w1: { email: 'someone-else@x.org', pin: '000000' } });
    const { registerNumber, calls } = make({ pinStore });
    let thrown;
    try { await registerNumber({ email: 'me@x.org', phoneNumberId: 'w1' }); } catch (e) { thrown = e; }

    thrown.message.should.include('w1');
    calls.register.should.have.lengthOf(0);
  });

  it('never returns or logs the PIN or the token', async () => {
    const logged = [];
    const original = { log: console.log, error: console.error, warn: console.warn };
    ['log', 'error', 'warn'].forEach(k => { console[k] = (...a) => logged.push(a.join(' ')); });
    try {
      const outcomes = await Promise.all([
        make().registerNumber({ email: 'me@x.org', phoneNumberId: 'w1' }),
        make({ health: [UNREGISTERED], register: { error: { code: 100, message: 'bad pin 123456' } } })
          .registerNumber({ email: 'me@x.org', phoneNumberId: 'w1' }),
      ]);
      const text = JSON.stringify(outcomes) + logged.join('\n');
      ['123456', 'SECRET1', 'access_token', 'pin"'].forEach(word => text.should.not.include(word));
    } finally {
      Object.assign(console, original);
    }
  });
});

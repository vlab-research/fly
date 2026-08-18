const { Pool } = require('pg');
const mocha = require('mocha');
const chai = require('chai');
const should = chai.should();
const Chatbase = require('./chatbase');
const { ChatbaseValidationError } = require('./errors')

// The database these tests run against. Defaults to the port
// `make -C devops test-db` publishes, and CHATBASE_TEST_PORT
// overrides it -- the same escape hatch scribble's tests use, so the suite can be
// pointed at a database that has the migrations under development applied without
// tearing down a shared one.
//
// THIS IS THE ONLY REPLYBOT TEST FILE THAT NEEDS AN EXTERNAL SERVICE. It came in
// with the client when the npm package was absorbed (see chatbase.js's header),
// and it cannot be made hermetic: what it tests IS the SQL. Every other replybot
// suite mocks its IO. `.github/workflows/replybot-test.yml` starts the database
// with `make -C devops test-db` for exactly this file.
//
// NOTE: `messages.account_id` requires devops/migrations/26-messages-account.sql.
// Against an older schema the scoped tests below fail with 42703 (undefined
// column), which is the correct and readable failure -- it names the missing
// migration rather than silently returning nothing.
const TEST_PORT = process.env.CHATBASE_TEST_PORT || 5433;

describe('Chatbase Postgres', () => {
  let chatbase;
  let pool;

  before(async () => {
    pool = new Pool({
      user: 'root',
      host: 'localhost',
      database: 'chatroach',
      port: TEST_PORT
    });

    chatbase = new Chatbase({
      user: 'root',
      host: 'localhost',
      database: 'chatroach',
      port: TEST_PORT
    });

    await chatbase.pool.query('DELETE FROM messages');
  });

  afterEach(async () => {
    await pool.query('DELETE FROM messages');
    await pool.query('DELETE FROM states');
  });

  describe('.get(key)', () => {
    it('should get a list of messages by key', async () => {
      const mockMessage = '{ "foo": "bar" }';
      await chatbase.put('123', mockMessage, new Date());
      const messages = await chatbase.get({ userid: '123', account: null });
      messages[0].should.equal('{ "foo": "bar" }');
    });

    it('gets multiple messages from one user', async () => {
      const mockMessages = ['{ "foo": "bar" }', '{ "baz": "qux" }'];
      for (let msg of mockMessages) {
        await chatbase.put('123', msg, new Date());
      }
      const messages = await chatbase.get({ userid: '123', account: null });
      messages[0].should.equal('{ "foo": "bar" }');
      messages[1].should.equal('{ "baz": "qux" }');
    });


    it('gets messages after pointer only', async () => {
      const now = new Date()
      const now_1 = new Date(+now + 3600000)
      const now_2 = new Date(+now_1 + 3600000)

      const mockMessages = [[{ "foo": "bar" }, now],
      [{ "foo": "baz" }, now_1],
      [{ "foo": "qux" }, now_2]];

      for (let [msg, date] of mockMessages) {
        await chatbase.put('123', JSON.stringify(msg), date);
      }

      const insertStates = `INSERT INTO
                            states(userid, pageid, updated, current_state, state_json)
                            VALUES ($1, $2, $3, $4, $5)`

      const state = { pointer: +now_1 }
      await chatbase.pool.query(insertStates, ["123", "bar", now, "QOUT", JSON.stringify(state)])

      const messages = await chatbase.get({ userid: '123', account: null });

      messages.length.should.equal(2)
      messages[0].should.equal('{"foo":"baz"}');
      messages[1].should.equal('{"foo":"qux"}');
    });

    it('ignores non-existent and null pointers', async () => {
      const now = new Date()
      const now_1 = new Date(+now + 3600000)
      const now_2 = new Date(+now_1 + 3600000)

      const mockMessages = [[{ "foo": "bar" }, now],
      [{ "foo": "baz" }, now_1],
      [{ "foo": "qux" }, now_2]];

      for (let [msg, date] of mockMessages) {
        await chatbase.put('123', JSON.stringify(msg), date);
      }

      const insertStates = `INSERT INTO
                            states(userid, pageid, updated, current_state, state_json)
                            VALUES ($1, $2, $3, $4, $5)`

      const state = { pointer: undefined }
      await chatbase.pool.query(insertStates, ["123", "bar", now, "QOUT", JSON.stringify(state)])

      const messages = await chatbase.get({ userid: '123', account: null });
      messages.length.should.equal(3)
    });

    it('should get defaults from env vars', async () => {
      const prev = process.env.CHATBASE_DATABASE;
      process.env.CHATBASE_DATABASE = 'chatroach';

      chatbase = new Chatbase({
        user: 'root',
        host: 'localhost',
        port: TEST_PORT
      });

      const mockMessage = '{ "foo": "bar" }';
      await chatbase.put('123', mockMessage, new Date());
      const messages = await chatbase.get({ userid: '123', account: null });
      messages[0].should.equal('{ "foo": "bar" }');

      process.env.CHATBASE_DATABASE = prev;
    });

    it('throws validation error if no host', async () => {
      const c = () => new Chatbase(undefined);
      c.should.throw(ChatbaseValidationError);
    })

    it('throws if operation fails (format)', async () => {
      let error;

      try {
        await chatbase.put('foo', 'bar', 'baz')
      } catch (e) {
        error = e
      }
      error.should.be.instanceof(Error)
    })

    it('throws if operation fails (permission denied)', async () => {
      await pool.query('CREATE USER chatbase');

      let chatbase = new Chatbase({
        user: 'chatbase',
        host: 'localhost',
        database: 'chatroach',
        port: TEST_PORT
      });

      let error;

      try {
        await chatbase.put('foo', 'bar', new Date())
      } catch (e) {
        error = e
      }

      error.should.be.instanceof(Error)
      await pool.query('DROP USER chatbase');
    })

    it('rethrows errors on pool error', async () => {
      class TestError extends Error { }
      let error;

      try {
        chatbase.pool.emit('error', new TestError('foo'));
      } catch (e) {
        error = e;
      }

      error.should.be.instanceof(TestError);
    });
  });

  // ---------------------------------------------------------------------------
  // Conversation-scoped reads. A conversation is (platform, account_id, user_id),
  // and reading by user id alone interleaves every account a participant has
  // talked to -- which is how one researcher's participant data ended up
  // reconstructed inside another researcher's conversation.
  // ---------------------------------------------------------------------------
  describe('.get({ userid, account })', () => {
    const ACCT_A = 'ACCOUNT_A';
    const ACCT_B = 'ACCOUNT_B';

    // messages rows in the shape scribble writes them, including the account.
    // put() deliberately does not take an account -- it is not on the live path,
    // scribble owns writes to this table -- so these go in directly.
    const archive = async (userid, content, account, timestamp) =>
      chatbase.pool.query(
        `INSERT INTO messages(userid, content, account_id, platform, timestamp)
         VALUES ($1, $2, $3, 'messenger', $4)`,
        [userid, content, account, timestamp],
      );

    const setPointer = async (userid, account, pointerMs, updated) =>
      chatbase.pool.query(
        `INSERT INTO states(userid, pageid, updated, current_state, state_json)
         VALUES ($1, $2, $3, 'QOUT', $4)`,
        [userid, account, updated, JSON.stringify(pointerMs === null ? {} : { pointer: pointerMs })],
      );

    it('reads only the conversation asked for', async () => {
      const t = Date.now();
      await archive('123', 'A_ONE', ACCT_A, new Date(t));
      await archive('123', 'B_ONE', ACCT_B, new Date(t + 1000));
      await archive('123', 'A_TWO', ACCT_A, new Date(t + 2000));

      const a = await chatbase.get({ userid: '123', account: ACCT_A });
      const b = await chatbase.get({ userid: '123', account: ACCT_B });

      // Non-vacuity first: an empty log would satisfy any isolation assertion.
      a.length.should.equal(2);
      b.length.should.equal(1);

      a.should.eql(['A_ONE', 'A_TWO']);
      b.should.eql(['B_ONE']);
    });

    it('includes rows whose account is not yet backfilled', async () => {
      // Historical rows predate migration 26 and carry NULL account_id. They must
      // still replay, or every pre-existing conversation comes back EMPTY. This
      // is the temporary `OR account_id IS NULL` branch; it is expected to be
      // removed once devops/backfill-messages-account.sh has drained.
      const t = Date.now();
      await archive('123', 'LEGACY', null, new Date(t));
      await archive('123', 'A_ONE', ACCT_A, new Date(t + 1000));

      const a = await chatbase.get({ userid: '123', account: ACCT_A });
      a.should.eql(['LEGACY', 'A_ONE']);
    });

    it('applies only THIS account\'s message_pointer', async () => {
      // The §2.2 item 4 leak: a form.reset on one account used to satisfy the
      // checkpoint for another, because the states subquery was joined on userid
      // and the pointer check passed if ANY account's pointer allowed it.
      const t = Date.now();
      const later = new Date(t + 10000);

      await archive('123', 'A_OLD', ACCT_A, new Date(t));
      await archive('123', 'B_OLD', ACCT_B, new Date(t + 1000));
      await archive('123', 'A_NEW', ACCT_A, new Date(t + 20000));
      await archive('123', 'B_NEW', ACCT_B, new Date(t + 21000));

      // Account A resets; account B does not.
      await setPointer('123', ACCT_A, +later, new Date(t));
      await setPointer('123', ACCT_B, null, new Date(t));

      const a = await chatbase.get({ userid: '123', account: ACCT_A });
      const b = await chatbase.get({ userid: '123', account: ACCT_B });

      a.should.eql(['A_NEW'], 'A is truncated at its own pointer');
      b.should.eql(['B_OLD', 'B_NEW'], "B must NOT be truncated by A's reset");
    });

    it('truncates un-backfilled rows too', async () => {
      // Why the states subquery is FILTERED by account rather than joined on
      // (userid, account_id): a NULL account_id matches nothing in a composite
      // join, so every un-backfilled row would get a NULL message_pointer and
      // bypass truncation entirely -- form.reset would silently stop working on
      // history until the backfill finished.
      const t = Date.now();
      await archive('123', 'LEGACY_OLD', null, new Date(t));
      await archive('123', 'A_NEW', ACCT_A, new Date(t + 20000));
      await setPointer('123', ACCT_A, t + 10000, new Date(t));

      const a = await chatbase.get({ userid: '123', account: ACCT_A });
      a.should.eql(['A_NEW']);
    });

    it('never returns the same row twice', async () => {
      // The other half of §2.2 item 4: the unfiltered states subquery returned
      // one row per account, duplicating every message row N times.
      const t = Date.now();
      await archive('123', 'A_ONE', ACCT_A, new Date(t));
      await setPointer('123', ACCT_A, null, new Date(t));
      await setPointer('123', ACCT_B, null, new Date(t));

      const a = await chatbase.get({ userid: '123', account: ACCT_A });
      a.should.eql(['A_ONE']);

      const all = await chatbase.get({ userid: '123', account: null });
      all.should.eql(['A_ONE'], 'the unscoped path must not duplicate either');
    });

    it('throws on a bare user id rather than silently reading unscoped', async () => {
      // The failure mode of this whole class of bug is silence, so an
      // un-updated caller must break at the first call rather than quietly keep
      // interleaving conversations.
      let error;
      try {
        await chatbase.get('123');
      } catch (e) {
        error = e;
      }
      error.should.be.instanceof(ChatbaseValidationError);
    });

    it('throws when the account key is absent entirely', async () => {
      // `account: null` means "genuinely unknown, read everything" and is
      // allowed. A MISSING key means the caller forgot, and that is not the same
      // thing.
      let error;
      try {
        await chatbase.get({ userid: '123' });
      } catch (e) {
        error = e;
      }
      error.should.be.instanceof(ChatbaseValidationError);
    });

    it('honours the limit', async () => {
      const t = Date.now();
      await archive('123', 'A_ONE', ACCT_A, new Date(t));
      await archive('123', 'A_TWO', ACCT_A, new Date(t + 1000));
      await archive('123', 'A_THREE', ACCT_A, new Date(t + 2000));

      const a = await chatbase.get({ userid: '123', account: ACCT_A }, 2);
      a.should.eql(['A_ONE', 'A_TWO']);
    });
  });
});

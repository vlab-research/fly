# ad_id projection — database verification (dashboard-server responses queries)

**Scope of this note**: verifying the one part of the ad-id-attribution change
that was never run against a real database — the two new
`responses.metadata->>'ad_id' AS ad_id` projections added to `_all` (backs
`GET /api/v1/responses` / `Response.all`) and `responsesQuery` (backs
`Response.formResponses`, the CSV download path) in
`dashboard-server/queries/responses/response.queries.js`.

Per the task constraints, only test files were touched:
`dashboard-server/queries/responses/response.test.js`. No production file
(`response.queries.js` or otherwise) was modified.

## How the test database was booted

`dashboard-server/docker-compose.yml` is the supported local stack (see
`dashboard-server/README.md` "Local development and tests"): CockroachDB on
port 5433 + a one-shot `migrate` container that applies every
`devops/migrations/*.sql` in sorted order, matching what
`facebot/testrunner/stack.ts` does for the message-pipeline suite
(`documentation/testing.md`). `config/index.js`'s `DATABASE_CONFIG` hard-codes
`host: localhost, port: 5433, database: chatroach, user: root` whenever
`NODE_ENV=test`, which is exactly what that compose file's CockroachDB service
exposes.

Because this repo runs ~20 git worktrees against one `.git`, and
`docker compose`'s default project name is the directory basename
(`dashboard-server` — identical across every worktree), running plain
`docker compose up -d` here would have created/reused containers named
`dashboard-server-cockroachdb-1` etc., which could collide with another
worktree's own dashboard-server stack. To stay isolated:

```bash
cd dashboard-server
cp .env-dev-example .env   # gitignored local template; MinIO creds, unused for this suite
docker compose -p adid-attr-dashboard up -d cockroachdb migrate
```

Only `cockroachdb` and `migrate` were started — `minio`/`minio-init` aren't
needed for `npm test` (they're only exercised by `npm run test:media`, which
was out of scope here). `docker logs adid-attr-dashboard-migrate-1` confirmed
all 23 files in `devops/migrations/*.sql` applied cleanly (exit code 0),
ending at `24-media-assets.sql`.

Dependencies were installed fresh (`npm install`, ~710 packages) since
worktrees don't share `node_modules`. Node v20.19.4 was used (no
`dashboard-server/.nvmrc` and no `engines` field in `package.json`); the
Dockerfile's pin to `node:14-bullseye` is a production build concern, not a
test-running one.

Containers are left running under the `adid-attr-dashboard` compose project
for anyone who wants to re-run or inspect. Tear down with:

```bash
cd dashboard-server && docker compose -p adid-attr-dashboard down -v
```

## Baseline (before any test-file edits)

`NODE_ENV=test npm test` (full suite, all files):

- **First run** (immediately after the DB was created): 478 passing, 2
  failing — both were `"before all" hook in "Response queries"` /
  `"after all" hook in "Response queries"` timing out at the mocha default
  5000ms. This was a cold-connection artifact (first `pg` `Pool` connection
  right after the CockroachDB container came up), not a real failure.
- **Second run** (DB warm): **488 passing, 1 failing** — the only failure was
  a pre-existing `chai` `.eql()` deep-equality mismatch in
  `response.test.js`'s `all()` → `'should return a list of responses for a
  survey created by a user'` test. The production `_all` query already
  projects `ad_id`, so every row `Response.all()` returns now carries an
  `ad_id` key, and the test's literal expected-array didn't have it yet.
  This is exactly the gap this task was meant to close — not a new bug.

Confirmed this diagnosis by running `response.test.js` in isolation with a
longer timeout (`npx mocha --timeout 20000 ./queries/responses/response.test.js`):
10 passing, 1 failing, same `.eql()` mismatch, no SQL error at all. **The SQL
itself (`responses.metadata->>'ad_id' AS ad_id` in both `_all` and
`responsesQuery`) is valid CockroachDB and executes without error.**

## Tests added

All in `dashboard-server/queries/responses/response.test.js`:

1. Fixed the pre-existing `.eql()` literal in `all()`'s
   `'should return a list of responses for a survey created by a user'` test
   to include `ad_id: null` on all four expected rows (their `metadata` is
   SQL NULL, since the file's `MOCK_QUERY` insert omits that column).
2. Added `res.responses.forEach(r => r.should.have.property('ad_id'))` inside
   the existing `describe('after', ...)` → `'should return all new responses
   after a given token'` test, asserting alongside the existing pagination
   assertion rather than rewriting it.
3. New `describe('ad_id projection', ...)` block (sibling to `describe('all()')`,
   scoped to its own survey/rows so it doesn't perturb any of the exact
   response-count assertions elsewhere in the file):
   - `'returns the ad_id value for a response whose metadata contains it'`
   - `'returns null (and does not error) when metadata has no ad_id key'`
   - `'returns null (and does not error) when metadata itself is SQL NULL'`
     (reuses the four pre-existing `survey`-scoped rows, whose `metadata` is
     SQL NULL)
   - `'does not disturb the pagination cursor when ad_id is present in the row'`
     — asserts the token round-trips correctly across a page boundary with
     `ad_id`-bearing rows in play
   - nested `describe('formResponses (CSV/stream path)', ...)` →
     `'includes ad_id on every streamed row'` — there was no existing test
     harness for `formResponses`/`responsesQuery` at all (confirmed via
     `grep -rln "formResponses\|responsesQuery"` — only
     `response.controller.js` and `response.queries.js` reference them). The
     new test drives `Response.formResponses(...)` directly and consumes the
     returned `ClientCursorStream` via `'data'`/`'end'`/`'error'` events,
     following the same consumption pattern as
     `node_modules/@vlab-research/client-cursor-stream/lib/cursor.test.js`.

## Final result

`NODE_ENV=test npm test`: **494 passing, 0 failing**
(478 unrelated tests, unchanged, + 16 in `response.test.js`, all green — 11
pre-existing + 5 new).

## Bug found

None. The `ad_id` SQL projection is valid and behaves as designed: present
when the JSONB key exists, `null` when the key is absent, `null` when
`metadata` itself is SQL NULL, and it does not interact with either
pagination cursor (`_all`'s `(timestamp, userid, question_ref)` tuple or
`responsesQuery`'s `(userid, timestamp, question_ref)` tuple).

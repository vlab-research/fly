const chai = require('chai')
const should = chai.should()
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

// ---------------------------------------------------------------------------
// THE DEPLOY CONTRACT: does the replybot tag we RUN decode what vlab MINTS?
//
// vlab's adopt/adopt/ref_encoding.py packs a shortcode and an opaque token into
// one base64url payload; decodeRecruitmentRef in typewheels/utils.js unpacks
// it. They are two independent implementations of one byte layout, in two
// languages, in two repositories, with nothing between them. The vectors in
// ref_encoding_vectors.json are the contract, and vlab asserts it mints exactly
// these strings in adopt/adopt/test_ref_encoding_contract.py.
//
// WHY THIS TEST LOADS A GIT TAG INSTEAD OF THE FILE NEXT TO IT
// -----------------------------------------------------------
// Because the mistake this project has already made once is code existing on a
// BRANCH while a TAG is what runs, and a test that requires `./utils` cannot
// see the difference. Three facts measured in this repository on 2026-08-26:
//
//   git show main:replybot/lib/typewheels/utils.js  | grep -c decodeRecruitmentRef
//     -> 0        (the local main was five days stale)
//   git show replybot-v0.0.221:.../utils.js         | grep -c decodeRecruitmentRef
//     -> 3        (the tag deployed in vprod AND vstag)
//   grep -c RefDecodeError replybot/lib/errors.js   (on a live feature branch)
//     -> 0        (the decoder's error type does not exist there either)
//
// Same repository, same minute, three different answers. A contract test that
// asserted against any of the checkouts would have been asserting about
// something no respondent will ever touch. So the tag named by
// devops/values/production.yaml is extracted out of git and required from a
// temporary tree, and THAT is what the vectors run through.
//
// The tree is temporary rather than a git worktree: worktrees are stateful,
// need cleaning up if a test process dies, and the two files below are all the
// decoder needs. `node_modules` is symlinked from replybot/ so `farmhash`
// resolves; `../errors` resolves because the temp tree mirrors the repo's
// directory shape rather than flattening it.
// ---------------------------------------------------------------------------

const REPO = path.resolve(__dirname, '..', '..', '..')
const REPLYBOT = path.resolve(__dirname, '..', '..')
const PROD_VALUES = path.join(REPO, 'devops', 'values', 'production.yaml')

const FIXTURE = require('./ref_encoding_vectors.json')

// The same constant lives in vlab's adopt/adopt/test_ref_encoding_contract.py.
// Recomputing the digest catches an edited vector; comparing it to this
// constant catches an edit that also updated the digest. Two copies of the
// fixture exist, one per repo, and this is what stops them drifting quietly.
const EXPECTED_DIGEST =
  '86d3374214a993346ee9f83390597be3d1d757e441c0380b5f166c3cbeb082e6'

// Files the decoder needs, at the paths it needs them at.
const NEEDED = [
  'replybot/lib/typewheels/utils.js',
  'replybot/lib/errors.js',
  'replybot/lib/event-normalizer.js',
]

// Read `versionReplybot` out of the production values file.
//
// By line-anchored regex rather than by parsing the YAML: the file is ~900
// lines of Helm values carrying anchors, aliases and merge keys, and a parse
// error anywhere in it would disable this check for a reason that has nothing
// to do with the contract. The one line we need has a fixed shape, and the
// optional `&anchor` between key and value is why a naive split(':')[1] does
// not work -- it yields '&vreplybot'.
function deployedReplybotTag() {
  const yaml = fs.readFileSync(PROD_VALUES, 'utf8')
  const m = yaml.match(/^versionReplybot:\s*(?:&\S+\s+)?(\S+)\s*$/m)
  if (!m) {
    throw new Error(`no versionReplybot line in ${PROD_VALUES}`)
  }
  return `replybot-${m[1]}`
}

// Materialise one git ref's copy of the decoder, and return its module.
function loadFromTag(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replybot-deployed-'))

  for (const rel of NEEDED) {
    // Strip the leading `replybot/` so the tree rooted at `dir` looks like
    // replybot/ does; `require('../errors')` from lib/typewheels then resolves.
    const dest = path.join(dir, rel.replace(/^replybot\//, ''))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(
      dest,
      execFileSync('git', ['show', `${tag}:${rel}`], {
        cwd: REPO,
        maxBuffer: 32 * 1024 * 1024,
      })
    )
  }

  fs.symlinkSync(path.join(REPLYBOT, 'node_modules'),
                 path.join(dir, 'node_modules'), 'dir')

  return {
    dir,
    utils: require(path.join(dir, 'lib', 'typewheels', 'utils.js')),
    normalizer: require(path.join(dir, 'lib', 'event-normalizer.js')),
  }
}

// Build the event shape getMetadata expects around a categorised payload.
// `source.type` is set explicitly so eventPlatform does not fall through to its
// guess-and-warn branch, which would make the test's output depend on an
// unrelated env var (STRICT_EVENT_PLATFORM).
function whatsappEvent(payload) {
  return {
    event_type: 'conversation_started',
    timestamp: 1756200000000,
    source: { type: 'whatsapp', account_id: '1203867182815254' },
    payload,
  }
}

describe('encoded ref: the DEPLOYED tag against vlab\'s minted vectors', () => {
  let tag
  let deployed

  before(function () {
    tag = deployedReplybotTag()
    deployed = loadFromTag(tag)
  })

  after(function () {
    if (deployed && deployed.dir) {
      fs.rmSync(deployed.dir, { recursive: true, force: true })
    }
  })

  it('names the tag it is testing, so a failure says which one', () => {
    tag.should.match(/^replybot-v\d+\.\d+\.\d+/)
    // Not an assertion about the value -- an assertion that the value was read
    // from the deploy manifest rather than hardcoded here. Printed so a CI log
    // records exactly which tag this run proved something about.
    console.log(`        deployed replybot tag: ${tag}`)
  })

  it('the deployed tag actually contains the decoder', () => {
    // Stated separately from the vectors below because the failure modes read
    // completely differently. A tag with no decoder is a DEPLOY problem: some
    // replybot tag was cut from a branch that does not carry this code, and
    // every encoded ref in flight is landing in FALLBACK_FORM. A tag with a
    // decoder that gets a vector wrong is a FORMAT problem. Collapsing the two
    // would report the first as the second.
    deployed.utils.should.have.property('decodeRecruitmentRef')
    deployed.utils.decodeRecruitmentRef.should.be.a('function')
  })

  describe('the fixture itself', () => {
    it('has not been edited', () => {
      const canon = canonical(FIXTURE.vectors)
      const digest = require('crypto')
        .createHash('sha256').update(canon, 'utf8').digest('hex')

      digest.should.equal(FIXTURE.digest,
        'a vector changed but the fixture\'s own digest did not')
      digest.should.equal(EXPECTED_DIGEST,
        'the fixture changed. It is the v1 wire format, and every ad already ' +
        'published carries exactly these bytes -- a format change is a new ' +
        'version, not an edit to this file')
    })

    it('is version 1', () => {
      FIXTURE.format_version.should.equal(1)
    })
  })

  describe('decodes every ref vlab mints', () => {
    // Declared eagerly rather than inside a loop in `before`: mocha needs the
    // cases to exist at definition time, and naming each by its own `why` is
    // what makes a failure readable without opening the fixture.
    FIXTURE.vectors.mint.forEach((v) => {
      it(`${v.encoded} -> ${v.shortcode} (${v.why})`, () => {
        const got = deployed.utils.decodeRecruitmentRef(v.encoded)
        got.form.should.equal(v.shortcode)
        got.token.should.equal(v.token)
      })
    })
  })

  describe('refuses everything a v1 decoder must refuse', () => {
    // The half that actually has teeth. A decoder that returned `{form: '',
    // token: ''}` for everything would pass every positive vector above by
    // accident of them being checked one at a time; nothing but these makes a
    // decoder prove it discriminates.
    FIXTURE.vectors.reject.forEach((v) => {
      it(`${JSON.stringify(v.encoded)} (${v.why})`, () => {
        should.throw(() => deployed.utils.decodeRecruitmentRef(v.encoded))
      })
    })
  })

  describe('the WhatsApp entry chain, end to end on the deployed tag', () => {
    // categorizeWhatsAppEvent -> getMetadata, which is the whole of what a
    // respondent's first WhatsApp message goes through. Asserted through the
    // exported functions rather than against the entry regex: the regex is
    // private, it has been widened twice, and what matters is not its shape but
    // whether md.form and md.vt come out right.
    FIXTURE.vectors.whatsapp_entry_accept.forEach((v) => {
      it(`accepts ${JSON.stringify(v.body)} (${v.why})`, () => {
        const cat = deployed.normalizer.categorizeWhatsAppEvent({
          type: 'text', text: { body: v.body },
        })

        cat.event_type.should.equal('conversation_started')
        cat.payload.referral.ref.should.equal(v.ref)

        const md = deployed.utils.getMetadata(whatsappEvent(cat.payload))
        md.form.should.equal(v.form)

        if (v.vt === null) {
          should.equal(md.vt, undefined,
            'a ref carrying no token must leave md.vt unset, not empty-string ' +
            '-- an empty token would join to any row whose ref_token is blank')
        } else {
          md.vt.should.equal(v.vt)
        }

        should.equal(md.r, undefined,
          'md.r is consumed by the decode branch and must never survive into ' +
          'the conversation metadata half-parsed')
      })
    })

    FIXTURE.vectors.whatsapp_entry_reject.forEach((v) => {
      it(`does not start a conversation on ${JSON.stringify(v.body)} (${v.why})`,
         () => {
           const cat = deployed.normalizer.categorizeWhatsAppEvent({
             type: 'text', text: { body: v.body },
           })
           const started = cat && cat.event_type === 'conversation_started'
           started.should.equal(false)
         })
    })

    FIXTURE.vectors.whatsapp_entry_throws.forEach((v) => {
      it(`throws rather than misrouting on ${JSON.stringify(v.body)} (${v.why})`,
         () => {
           const cat = deployed.normalizer.categorizeWhatsAppEvent({
             type: 'text', text: { body: v.body },
           })
           // The gate accepts it -- its alphabet cannot tell a valid payload
           // from a corrupt one -- so the loudness has to come from the decode.
           cat.event_type.should.equal('conversation_started')
           should.throw(
             () => deployed.utils.getMetadata(whatsappEvent(cat.payload)),
             v.error
           )
         })
    })
  })
})

// The canonical serialisation both repos hash. Mirrors Python's
// json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False):
// keys sorted, no whitespace, non-ASCII left as real characters. Written out
// rather than reached for from a library because a library that formats floats
// or escapes non-ASCII differently would produce a digest that never matches
// vlab's, and the failure would look like a fixture edit.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  return '{' + Object.keys(value).sort()
    .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
    .join(',') + '}'
}

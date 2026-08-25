const mocha = require('mocha')
const chai = require('chai')
const should = chai.should()
const {
  translateTypeformField,
  makeUrl,
  identityParams,
  splitDestination,
  buildLinkTrackingUrl,
  buildMoviehouseUrl,
  IDENTITY_PARAMS,
  VIDEO_PARAM
} = require('./generic-translator')

describe('translateTypeformField', () => {

  describe('translateAttachment', () => {
    it('preserves field.md (including keepMoving) in metadata', () => {
      const field = {
        type: 'attachment',
        ref: 'attachment_1',
        title: 'Please share an image',
        md: { keepMoving: true, customFlag: 'test' },
        properties: {
          description: ''
        }
      }

      const result = translateTypeformField(field)

      result.should.have.property('metadata')
      result.metadata.should.have.property('keepMoving', true)
      result.metadata.should.have.property('customFlag', 'test')
      result.metadata.should.have.property('ref', 'attachment_1')
      result.metadata.should.have.property('type', 'attachment')
    })

    it('preserves attachment metadata when field.md is empty', () => {
      const field = {
        type: 'attachment',
        ref: 'attachment_2',
        title: 'Share your photo',
        md: {},
        properties: {
          description: ''
        }
      }

      const result = translateTypeformField(field)

      result.should.have.property('metadata')
      result.metadata.should.have.property('ref', 'attachment_2')
      result.metadata.should.have.property('type', 'attachment')
      // Should not have unexpected properties
      result.metadata.should.not.have.property('keepMoving')
    })

    it('has correct media and caption fields', () => {
      const field = {
        type: 'attachment',
        ref: 'att_3',
        title: 'Attachment Title',
        md: { keepMoving: true },
        properties: {
          description: 'Some description'
        }
      }

      const result = translateTypeformField(field)

      result.should.have.property('type', 'media')
      result.should.have.property('caption', 'Attachment Title')
      result.should.have.property('media_type', 'image')
    })

    it('sends pre-uploaded media by attachment_id, not as a URL', () => {
      const field = {
        type: 'attachment',
        ref: 'contraceptive_image',
        title: 'Contraceptive 1',
        md: {
          type: 'attachment',
          keepMoving: true,
          attachment: { type: 'image', attachment_id: '1658615935222752' }
        },
        properties: { description: '' }
      }

      const result = translateTypeformField(field)

      result.should.have.property('media_attachment_id', '1658615935222752')
      // Regression guard: the md JSON used to leak into media_url, and Messenger
      // rejected it with (#100) "... should represent a valid URL".
      should.equal(result.media_url, null)
      result.should.have.property('media_type', 'image')
    })

    it('still sends URL-based media by URL', () => {
      const field = {
        type: 'attachment',
        ref: 'att_url',
        title: 'A picture',
        md: { attachment: { type: 'image', url: 'https://example.com/i.jpg' } },
        properties: { description: '' }
      }

      const result = translateTypeformField(field)

      result.should.have.property('media_url', 'https://example.com/i.jpg')
      should.equal(result.media_attachment_id, null)
    })
  })

  describe('translateStatement', () => {
    it('preserves field.md in metadata (existing behavior)', () => {
      const field = {
        type: 'statement',
        ref: 'stmt_1',
        title: 'Thank you for your response',
        md: { keepMoving: true, customData: 'value' },
        properties: {}
      }

      const result = translateTypeformField(field)

      result.metadata.should.have.property('keepMoving', true)
      result.metadata.should.have.property('customData', 'value')
      result.metadata.should.have.property('type', 'statement')
    })
  })

  describe('translateQuestionWithChoices', () => {
    it('preserves field.md in metadata', () => {
      const field = {
        type: 'multiple_choice',
        ref: 'q_1',
        title: 'Pick one',
        md: { keepMoving: false },
        properties: {
          choices: [
            { label: 'Option A', ref: 'opt_a' },
            { label: 'Option B', ref: 'opt_b' }
          ]
        }
      }

      const result = translateTypeformField(field)

      result.metadata.should.have.property('keepMoving', false)
      result.metadata.should.have.property('ref', 'q_1')
    })

    it('uses choice label as value (not ref)', () => {
      const field = {
        type: 'multiple_choice',
        ref: 'q_1',
        title: 'Pick one',
        properties: {
          choices: [
            { label: 'Option A', ref: 'opt_a' },
            { label: 'Option B', ref: 'opt_b' }
          ]
        }
      }

      const result = translateTypeformField(field)

      result.options.should.have.lengthOf(2)
      result.options[0].should.deep.equal({ value: 'Option A', label: 'Option A', description: null })
      result.options[1].should.deep.equal({ value: 'Option B', label: 'Option B', description: null })
    })
  })

  describe('translateYesNo', () => {
    it('uses string labels as values (not booleans)', () => {
      const field = {
        type: 'yes_no',
        ref: 'q_yes_no',
        title: 'Do you agree?'
      }

      const result = translateTypeformField(field)

      result.options.should.have.lengthOf(2)
      result.options[0].should.deep.equal({ value: 'Yes', label: 'Yes', description: null })
      result.options[1].should.deep.equal({ value: 'No', label: 'No', description: null })
    })
  })

  describe('translateLegal', () => {
    it('uses string labels as values (not booleans)', () => {
      const field = {
        type: 'legal',
        ref: 'q_legal',
        title: 'Do you accept?'
      }

      const result = translateTypeformField(field)

      result.options.should.have.lengthOf(2)
      result.options[0].should.deep.equal({ value: 'I Accept', label: 'I Accept', description: null })
      result.options[1].should.deep.equal({ value: "I don't Accept", label: "I don't Accept", description: null })
    })
  })

  // -------------------------------------------------------------------------
  // First-party field types: `link_tracking` and `moviehouse`.
  //
  // replybot owns these URLs end to end. There is deliberately NO host
  // allowlist, NO per-service param scheme and NO `tracked` flag to test,
  // because none of them exist any more -- the field type IS the opt-in and the
  // base address comes from config. See the header of generic-translator.js.
  // -------------------------------------------------------------------------

  const CTX = {
    user: { id: 'user-123' },
    page: { id: 'page-456' },
    platform: 'whatsapp'
  }

  const LINK_BASE = 'https://links.vlab.digital'
  const MOVIE_BASE = 'https://virtuallab-videos.netlify.app'

  function withEnv(vars, fn) {
    const saved = {}
    Object.keys(vars).forEach(k => {
      saved[k] = process.env[k]
      if (vars[k] === null) delete process.env[k]
      else process.env[k] = vars[k]
    })
    try {
      return fn()
    } finally {
      Object.keys(saved).forEach(k => {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      })
    }
  }

  describe('identityParams', () => {
    it('names every component with the ONE canonical param set', () => {
      const { params, missing } = identityParams(CTX)

      params.should.deep.equal({
        vlab_user: 'user-123',
        vlab_account: 'page-456',
        vlab_platform: 'whatsapp'
      })
      missing.should.be.empty
    })

    it('uses the same names regardless of which service they are for', () => {
      // The whole point: one set of names, both ends owned by replybot. There
      // is no scheme argument to get wrong.
      identityParams.length.should.equal(1)
      Object.keys(IDENTITY_PARAMS).should.deep.equal(['user', 'account', 'platform'])
      IDENTITY_PARAMS.user.should.equal('vlab_user')
      IDENTITY_PARAMS.account.should.equal('vlab_account')
      IDENTITY_PARAMS.platform.should.equal('vlab_platform')
    })

    it('omits a missing component rather than stamping an empty string', () => {
      const { params, missing } = identityParams({ user: { id: 'u' }, platform: 'messenger' })

      params.should.deep.equal({ vlab_user: 'u', vlab_platform: 'messenger' })
      missing.should.deep.equal(['page.id'])
    })

    it('reports every component when ctx is missing entirely', () => {
      const { params, missing } = identityParams(undefined)

      params.should.deep.equal({})
      missing.should.deep.equal(['user.id', 'page.id', 'platform'])
    })

    it('coerces a numeric account id to a string', () => {
      const { params } = identityParams({ user: { id: 1 }, page: { id: 105246245358509 }, platform: 'messenger' })
      params.vlab_account.should.equal('105246245358509')
    })
  })

  describe('splitDestination', () => {
    it('splits https', () => {
      splitDestination('https://who.int/hpv').should.deep.equal({ protocol: 'https', target: 'who.int/hpv' })
    })

    it('splits http', () => {
      splitDestination('http://who.int/hpv').should.deep.equal({ protocol: 'http', target: 'who.int/hpv' })
    })

    it('assumes https when the researcher omits the scheme', () => {
      splitDestination('who.int/hpv').should.deep.equal({ protocol: 'https', target: 'who.int/hpv' })
    })

    // documentation/platform-abstraction.md: tel:/mailto:/sms: destinations are
    // *expected* to route through the tracking service, and linksniffer
    // rebuilds them with a single colon (server.go buildRedirectURL).
    it('splits tel: without eating the number', () => {
      splitDestination('tel:+234-0700-220-1122').should.deep.equal({ protocol: 'tel', target: '+234-0700-220-1122' })
    })

    it('splits mailto:', () => {
      splitDestination('mailto:hi@example.com').should.deep.equal({ protocol: 'mailto', target: 'hi@example.com' })
    })

    it('splits sms:', () => {
      splitDestination('sms:12345').should.deep.equal({ protocol: 'sms', target: '12345' })
    })

    it('lowercases the scheme', () => {
      splitDestination('HTTPS://who.int').should.deep.equal({ protocol: 'https', target: 'who.int' })
    })

    it('keeps a query string on the destination intact', () => {
      splitDestination('https://who.int/hpv?lang=fr&x=1')
        .should.deep.equal({ protocol: 'https', target: 'who.int/hpv?lang=fr&x=1' })
    })
  })

  describe('buildLinkTrackingUrl', () => {
    it('builds the whole url from base, destination and conversation', () => {
      const { url, missing } = buildLinkTrackingUrl(LINK_BASE, 'https://who.int/hpv', CTX)
      const u = new URL(url)

      u.origin.should.equal('https://links.vlab.digital')
      u.searchParams.get('url').should.equal('who.int/hpv')
      u.searchParams.get('p').should.equal('https')
      u.searchParams.get('vlab_user').should.equal('user-123')
      u.searchParams.get('vlab_account').should.equal('page-456')
      u.searchParams.get('vlab_platform').should.equal('whatsapp')
      missing.should.be.empty
    })

    it('carries a tel: destination as p=tel', () => {
      const { url } = buildLinkTrackingUrl(LINK_BASE, 'tel:+2340700', CTX)
      const u = new URL(url)

      u.searchParams.get('p').should.equal('tel')
      u.searchParams.get('url').should.equal('+2340700')
    })

    it('honours a base that carries a path', () => {
      const { url } = buildLinkTrackingUrl('https://links.vlab.digital/go', 'https://who.int', CTX)
      new URL(url).pathname.should.equal('/go')
    })

    it('discards any query string already on the configured base', () => {
      const { url } = buildLinkTrackingUrl('https://links.vlab.digital/?stale=1', 'https://who.int', CTX)
      should.not.exist(new URL(url).searchParams.get('stale'))
    })

    it('percent-encodes a destination that contains its own query string', () => {
      const { url } = buildLinkTrackingUrl(LINK_BASE, 'https://who.int/hpv?lang=fr&x=1', CTX)
      const u = new URL(url)

      // The destination must survive as ONE param, not leak `lang` and `x` into
      // linksniffer's own query string.
      u.searchParams.get('url').should.equal('who.int/hpv?lang=fr&x=1')
      should.not.exist(u.searchParams.get('lang'))
      should.not.exist(u.searchParams.get('x'))
    })

    it('reports missing identity components without refusing to build', () => {
      const { url, missing } = buildLinkTrackingUrl(LINK_BASE, 'https://who.int', { user: { id: 'u' } })

      missing.should.deep.equal(['page.id', 'platform'])
      new URL(url).searchParams.get('vlab_user').should.equal('u')
    })
  })

  describe('buildMoviehouseUrl', () => {
    it('builds the whole url from base, video id and conversation', () => {
      const { url, missing } = buildMoviehouseUrl(MOVIE_BASE, '164118668', CTX)
      const u = new URL(url)

      u.origin.should.equal('https://virtuallab-videos.netlify.app')
      u.searchParams.get('vlab_video').should.equal('164118668')
      u.searchParams.get('vlab_user').should.equal('user-123')
      u.searchParams.get('vlab_account').should.equal('page-456')
      u.searchParams.get('vlab_platform').should.equal('whatsapp')
      missing.should.be.empty
    })

    // The collision that forced two param schemes in the previous design, and
    // that would have rendered "we couldn't find that video" on every field, is
    // now structurally impossible: the video has its own name and the
    // participant has its own name, and neither is `id`.
    it('never emits a bare `id`, so the participant cannot clobber the video', () => {
      const { url } = buildMoviehouseUrl(MOVIE_BASE, '164118668', CTX)
      const u = new URL(url)

      should.not.exist(u.searchParams.get('id'))
      u.searchParams.get('vlab_video').should.not.equal('user-123')
      VIDEO_PARAM.should.not.equal(IDENTITY_PARAMS.user)
    })

    it('coerces a video id YAML parsed as a number', () => {
      const { url } = buildMoviehouseUrl(MOVIE_BASE, 164118668, CTX)
      new URL(url).searchParams.get('vlab_video').should.equal('164118668')
    })

    it('emits no account param for a researcher to have hardcoded', () => {
      const { url } = buildMoviehouseUrl(MOVIE_BASE, '1', CTX)
      const u = new URL(url)

      should.not.exist(u.searchParams.get('pageId'))
      should.not.exist(u.searchParams.get('pageid'))
      u.searchParams.get('vlab_account').should.equal('page-456')
    })
  })

  describe('translateTypeformField - link_tracking', () => {
    const field = () => ({
      type: 'link_tracking',
      ref: 'hpv_link',
      title: 'Learn about the HPV vaccine.',
      md: {
        type: 'link_tracking',
        url: 'https://who.int/hpv',
        buttonText: 'Read more',
        keepMoving: true
      },
      properties: {}
    })

    it('renders as a webview on the wire', () => {
      withEnv({ LINKSNIFFER_URL: LINK_BASE }, () => {
        const result = translateTypeformField(field(), CTX)

        // metadata.type is the discriminator message-worker routes on for BOTH
        // transports, and the key generic-validator looks up. It must stay
        // 'webview' -- the new type is an authoring-time concept only.
        result.metadata.type.should.equal('webview')
        result.type.should.equal('text')
        result.text.should.equal('Learn about the HPV vaccine.')
        result.metadata.buttonText.should.equal('Read more')
        result.metadata.ref.should.equal('hpv_link')
      })
    })

    it('builds the url from config, not from anything the researcher wrote', () => {
      withEnv({ LINKSNIFFER_URL: LINK_BASE }, () => {
        const u = new URL(translateTypeformField(field(), CTX).metadata.url)

        u.origin.should.equal('https://links.vlab.digital')
        u.searchParams.get('url').should.equal('who.int/hpv')
        u.searchParams.get('vlab_user').should.equal('user-123')
      })
    })

    it('follows the configured base when config changes', () => {
      withEnv({ LINKSNIFFER_URL: 'https://staging.links.vlab.digital' }, () => {
        const u = new URL(translateTypeformField(field(), CTX).metadata.url)
        u.origin.should.equal('https://staging.links.vlab.digital')
      })
    })

    it('carries keepMoving through untouched', () => {
      withEnv({ LINKSNIFFER_URL: LINK_BASE }, () => {
        translateTypeformField(field(), CTX).metadata.keepMoving.should.equal(true)
      })
    })

    it('carries a wait on linksniffer:click through untouched', () => {
      const f = field()
      delete f.md.keepMoving
      f.md.responseMessage = 'Click the button'
      f.md.wait = { type: 'external', value: { type: 'linksniffer:click' } }

      withEnv({ LINKSNIFFER_URL: LINK_BASE }, () => {
        const md = translateTypeformField(f, CTX).metadata

        md.wait.should.deep.equal({ type: 'external', value: { type: 'linksniffer:click' } })
        md.responseMessage.should.equal('Click the button')
      })
    })

    it('defaults extensions to false so the Messenger button opens', () => {
      withEnv({ LINKSNIFFER_URL: LINK_BASE }, () => {
        translateTypeformField(field(), CTX).metadata.extensions.should.equal(false)
      })
    })

    it('lets a researcher override extensions', () => {
      const f = field()
      f.md.extensions = true

      withEnv({ LINKSNIFFER_URL: LINK_BASE }, () => {
        translateTypeformField(f, CTX).metadata.extensions.should.equal(true)
      })
    })

    it('defaults buttonText', () => {
      const f = field()
      delete f.md.buttonText

      withEnv({ LINKSNIFFER_URL: LINK_BASE }, () => {
        translateTypeformField(f, CTX).metadata.buttonText.should.equal('View website')
      })
    })

    it('throws a greppable, actionable error when LINKSNIFFER_URL is unset', () => {
      withEnv({ LINKSNIFFER_URL: null }, () => {
        let err = null
        try { translateTypeformField(field(), CTX) } catch (e) { err = e }

        should.exist(err)
        err.message.should.contain('[MISSING_SERVICE_URL]')
        err.message.should.contain('LINKSNIFFER_URL')
        err.message.should.contain('hpv_link')
        // No `tag`: transition.js routes an untagged error to STATE_ACTIONS,
        // which is read downstream as "platform fault". A missing env var is
        // ours, not the researcher's.
        should.not.exist(err.tag)
      })
    })

    it('treats a blank LINKSNIFFER_URL as unset rather than building a bad url', () => {
      withEnv({ LINKSNIFFER_URL: '   ' }, () => {
        let err = null
        try { translateTypeformField(field(), CTX) } catch (e) { err = e }

        should.exist(err)
        err.message.should.contain('[MISSING_SERVICE_URL]')
      })
    })

    it('names the variable when the configured base has no scheme', () => {
      withEnv({ LINKSNIFFER_URL: 'links.vlab.digital' }, () => {
        let err = null
        try { translateTypeformField(field(), CTX) } catch (e) { err = e }

        should.exist(err)
        err.message.should.contain('[INVALID_SERVICE_URL]')
        err.message.should.contain('LINKSNIFFER_URL')
        err.message.should.contain('links.vlab.digital')
      })
    })

    it('throws when the researcher supplied no destination', () => {
      const f = field()
      delete f.md.url

      withEnv({ LINKSNIFFER_URL: LINK_BASE }, () => {
        let err = null
        try { translateTypeformField(f, CTX) } catch (e) { err = e }

        should.exist(err)
        err.message.should.contain('[MISSING_FIELD_CONTENT]')
        err.message.should.contain('hpv_link')
      })
    })
  })

  describe('translateTypeformField - moviehouse', () => {
    const field = () => ({
      type: 'moviehouse',
      ref: 'movie_1',
      title: 'Watch this short film.',
      md: {
        type: 'moviehouse',
        videoId: '164118668',
        buttonText: 'Watch the video',
        wait: { type: 'external', value: { type: 'moviehouse:play' } }
      },
      properties: {}
    })

    it('renders as a webview on the wire', () => {
      withEnv({ MOVIEHOUSE_URL: MOVIE_BASE }, () => {
        const result = translateTypeformField(field(), CTX)

        result.metadata.type.should.equal('webview')
        result.metadata.buttonText.should.equal('Watch the video')
        result.metadata.ref.should.equal('movie_1')
      })
    })

    it('builds the url from config and the conversation', () => {
      withEnv({ MOVIEHOUSE_URL: MOVIE_BASE }, () => {
        const u = new URL(translateTypeformField(field(), CTX).metadata.url)

        u.origin.should.equal('https://virtuallab-videos.netlify.app')
        u.searchParams.get('vlab_video').should.equal('164118668')
        u.searchParams.get('vlab_user').should.equal('user-123')
        u.searchParams.get('vlab_account').should.equal('page-456')
        u.searchParams.get('vlab_platform').should.equal('whatsapp')
      })
    })

    // The 2026-08-13 incident in one assertion: a WhatsApp participant whose
    // moviehouse event was routed to a hardcoded Messenger page, producing a
    // phantom conversation that is still BLOCKED in production. A researcher
    // can no longer express that, because there is nowhere to put a page id.
    it('cannot be given a hardcoded account by the researcher', () => {
      const f = field()
      f.md.pageId = '101435865704727'

      withEnv({ MOVIEHOUSE_URL: MOVIE_BASE }, () => {
        const u = new URL(translateTypeformField(f, CTX).metadata.url)

        u.searchParams.get('vlab_account').should.equal('page-456')
        u.searchParams.get('vlab_platform').should.equal('whatsapp')
        // The stray authoring key rides in metadata but never reaches the URL.
        should.not.exist(u.searchParams.get('pageId'))
        new URL(translateTypeformField(f, CTX).metadata.url).href.should.not.contain('101435865704727')
      })
    })

    it('carries a wait on moviehouse:play through untouched', () => {
      withEnv({ MOVIEHOUSE_URL: MOVIE_BASE }, () => {
        translateTypeformField(field(), CTX).metadata.wait
          .should.deep.equal({ type: 'external', value: { type: 'moviehouse:play' } })
      })
    })

    // 126 of 570 production fields use the `op: or` timeout shape. It is just
    // another value on `md.wait`, and it must survive verbatim.
    it('carries a compound play-or-timeout wait through untouched', () => {
      const f = field()
      f.md.wait = {
        op: 'or',
        vars: [
          { type: 'external', value: { type: 'moviehouse:play' } },
          { type: 'timeout', value: { type: 'relative', timeout: '1 hour' } }
        ]
      }

      withEnv({ MOVIEHOUSE_URL: MOVIE_BASE }, () => {
        translateTypeformField(f, CTX).metadata.wait.should.deep.equal(f.md.wait)
      })
    })

    it('carries keepMoving through untouched', () => {
      const f = field()
      delete f.md.wait
      f.md.keepMoving = true

      withEnv({ MOVIEHOUSE_URL: MOVIE_BASE }, () => {
        const md = translateTypeformField(f, CTX).metadata
        md.keepMoving.should.equal(true)
        should.not.exist(md.wait)
      })
    })

    it('defaults extensions to false -- direct mode is what replybot enables', () => {
      withEnv({ MOVIEHOUSE_URL: MOVIE_BASE }, () => {
        translateTypeformField(field(), CTX).metadata.extensions.should.equal(false)
      })
    })

    it('follows the configured staging base', () => {
      withEnv({ MOVIEHOUSE_URL: 'https://staging--virtuallab-videos.netlify.app' }, () => {
        new URL(translateTypeformField(field(), CTX).metadata.url)
          .origin.should.equal('https://staging--virtuallab-videos.netlify.app')
      })
    })

    it('throws a greppable, actionable error when MOVIEHOUSE_URL is unset', () => {
      withEnv({ MOVIEHOUSE_URL: null }, () => {
        let err = null
        try { translateTypeformField(field(), CTX) } catch (e) { err = e }

        should.exist(err)
        err.message.should.contain('[MISSING_SERVICE_URL]')
        err.message.should.contain('MOVIEHOUSE_URL')
        err.message.should.contain('movie_1')
        should.not.exist(err.tag)
      })
    })

    it('throws when the researcher supplied no videoId', () => {
      const f = field()
      delete f.md.videoId

      withEnv({ MOVIEHOUSE_URL: MOVIE_BASE }, () => {
        let err = null
        try { translateTypeformField(f, CTX) } catch (e) { err = e }

        should.exist(err)
        err.message.should.contain('[MISSING_FIELD_CONTENT]')
        err.message.should.contain('movie_1')
      })
    })

    it('needs no config at all for an unrelated field type', () => {
      withEnv({ MOVIEHOUSE_URL: null, LINKSNIFFER_URL: null }, () => {
        const result = translateTypeformField(
          { type: 'short_text', ref: 'q1', title: 'Your name?', properties: {} },
          CTX
        )
        result.type.should.equal('text')
      })
    })
  })

  // -------------------------------------------------------------------------
  // Hand-authored `webview` fields. Untouched by any of the above: no host
  // matching, no identity, no decoration. They stay exactly as broken or as
  // working as they are today, and the migration path is to change the type.
  // -------------------------------------------------------------------------

  describe('makeUrl - object form', () => {
    it('renders the object form from base and params', () => {
      const result = makeUrl({ base: 'example.com', params: { url: 'test.com' } })
      result.should.include('example.com')
      result.should.include('url=test.com')
    })

    it('honours an explicit protocol', () => {
      makeUrl({ base: 'example.com', protocol: 'http', params: {} })
        .indexOf('http://example.com').should.equal(0)
    })

    it('throws on an object with no base', () => {
      let err = null
      try { makeUrl({ params: { a: 1 } }) } catch (e) { err = e }
      should.exist(err)
    })
  })

  describe('makeUrl - string form', () => {
    it('returns a string url completely unchanged', () => {
      const url = 'https://example.com?url=test.com&id='
      makeUrl(url).should.equal(url)
    })

    it('returns a non-url string unchanged and does not throw', () => {
      makeUrl('not a valid url').should.equal('not a valid url')
    })

    it('does not touch a tel: destination', () => {
      makeUrl('tel:+234-0700-220-1122').should.equal('tel:+234-0700-220-1122')
    })
  })

  describe('translateWebview - hand-authored, undecorated', () => {
    const ctx = CTX

    it('returns a string URL byte-identical, even on one of our own hosts', () => {
      const originalUrl = 'https://links.vlab.digital?url=populationfoundation.in&id='
      const field = {
        type: 'webview',
        ref: 'wv_legacy',
        title: 'Visit',
        md: { url: originalUrl, buttonText: 'Go', keepMoving: true },
        properties: {}
      }

      const result = translateTypeformField(field, ctx)

      result.metadata.url.should.equal(originalUrl)
      result.metadata.keepMoving.should.equal(true)
    })

    it('does not stamp identity into a legacy moviehouse url', () => {
      const originalUrl = 'https://virtuallab-videos.netlify.app/?id=1143993262&pageId=101435865704727'
      const field = {
        type: 'webview',
        ref: 'wv_movie_legacy',
        title: 'Watch',
        md: { url: originalUrl, buttonText: 'Watch' },
        properties: {}
      }

      const result = translateTypeformField(field, ctx)

      result.metadata.url.should.equal(originalUrl)
      result.metadata.url.should.not.contain('vlab_user')
    })

    it('does not stamp identity into a third-party url', () => {
      const originalUrl = 'https://asiapacific.unwomen.org/en/countries/india'
      const field = {
        type: 'webview',
        ref: 'wv_third_party',
        title: 'Visit',
        md: { url: originalUrl, buttonText: 'Go' },
        properties: {}
      }

      translateTypeformField(field, ctx).metadata.url.should.equal(originalUrl)
    })

    it('renders the object url form unchanged', () => {
      const field = {
        type: 'webview',
        ref: 'wv_obj',
        title: 'Visit',
        md: { url: { base: 'example.com', params: { url: 'test.com' } }, buttonText: 'Go' },
        properties: {}
      }

      const result = translateTypeformField(field, ctx)

      result.metadata.url.should.include('example.com')
      result.metadata.url.should.include('url=test.com')
    })

    it('needs no ctx and no config', () => {
      const originalUrl = 'https://links.vlab.digital?url=example.com&id='
      const field = {
        type: 'webview',
        ref: 'wv_no_ctx',
        title: 'Visit',
        md: { url: originalUrl, buttonText: 'Go' },
        properties: {}
      }

      withEnv({ LINKSNIFFER_URL: null, MOVIEHOUSE_URL: null }, () => {
        translateTypeformField(field).metadata.url.should.equal(originalUrl)
      })
    })

    // `tracked` no longer exists. A survey that still carries it is a plain
    // webview and the key is inert metadata -- it must not resurrect any
    // stamping behaviour, and it must not throw.
    it('ignores a leftover `tracked: true` entirely', () => {
      const originalUrl = 'https://links.vlab.digital?url=example.com&id='
      const field = {
        type: 'webview',
        ref: 'wv_stale_tracked',
        title: 'Visit',
        md: { tracked: true, url: originalUrl, buttonText: 'Go' },
        properties: {}
      }

      const result = translateTypeformField(field, ctx)

      result.metadata.url.should.equal(originalUrl)
      result.metadata.url.should.not.contain('vlab_user')
    })
  })
})

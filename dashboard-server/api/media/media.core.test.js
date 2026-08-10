'use strict';

const zlib = require('zlib');
const chai = require('chai');
const should = chai.should(); // eslint-disable-line no-unused-vars

const {
  MEDIA_TYPE_LIMITS,
  ALLOWED_MIME_TYPES,
  DEFAULT_RECONCILE_POLICY,
  OCTET_STREAM,
  hashContent,
  storageKeyFor,
  publicUrlFor,
  parseAssetId,
  sniffContentType,
  validateUpload,
  buildAssetRecord,
  planReconcile,
} = require('./media.core');

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const BASE = 'https://media.vlab.digital';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const at = s => new Date(s);

// --- byte fixtures: real magic numbers, so the sniffer is tested against the
// --- thing it actually has to recognise rather than against itself.
const bytes = (...b) => Buffer.from(b);
const withAscii = (prefix, ascii) => Buffer.concat([Buffer.from(prefix), Buffer.from(ascii, 'latin1')]);

const JPEG = Buffer.concat([bytes(0xff, 0xd8, 0xff, 0xe0), Buffer.alloc(16)]);
// A real PNG header, not just the signature: bit depth (byte 24) and colour type
// (byte 25) live in the IHDR chunk, and Meta refuses anything that is not 8-bit.
const pngWith = (bitDepth, colourType) => {
  const buf = Buffer.alloc(33);
  bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a).copy(buf);
  buf.writeUInt32BE(13, 8); // IHDR payload length
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(1, 16); // width
  buf.writeUInt32BE(1, 20); // height
  buf[24] = bitDepth;
  buf[25] = colourType;
  return buf;
};
const PNG = pngWith(8, 6); // 8-bit RGBA — what Meta accepts
const PNG_16BIT = pngWith(16, 6);
const PNG_4BIT = pngWith(4, 3); // 4-bit palette
const PNG_GREY_8BIT = pngWith(8, 0);
const PNG_HEADERLESS = Buffer.concat([bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), Buffer.alloc(16)]);
const GIF = Buffer.from('GIF89a' + '\x00'.repeat(10), 'latin1');
const WEBP = withAscii([], 'RIFF\x00\x00\x00\x00WEBPVP8 ');
const WAV = withAscii([], 'RIFF\x00\x00\x00\x00WAVEfmt ');
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ', 'latin1');
const MP4 = withAscii([0, 0, 0, 0x20], 'ftypisom\x00\x00\x02\x00');
const MOV = withAscii([0, 0, 0, 0x14], 'ftypqt  \x00\x00\x02\x00');
const THREEGP = withAscii([0, 0, 0, 0x18], 'ftyp3gp4\x00\x00\x03\x00');
const M4A = withAscii([0, 0, 0, 0x20], 'ftypM4A \x00\x00\x02\x00');
const MP3_ID3 = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1');
const MP3_FRAME = bytes(0xff, 0xfb, 0x90, 0x00, 0x00, 0x00);
const OGG = Buffer.from('OggS\x00\x02\x00\x00', 'latin1');
const AMR = Buffer.from('#!AMR\n\x00\x00', 'latin1');
const WEBM = Buffer.concat([bytes(0x1a, 0x45, 0xdf, 0xa3), Buffer.alloc(16)]);

// --- ZIP / OOXML fixtures, built as real local file headers so the sniffer is
// --- tested against the byte layout it actually parses.
const zipEntry = (name, content, method = 8) => {
  const nameBuf = Buffer.from(name, 'latin1');
  const raw = Buffer.from(content, 'latin1');
  const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
  const header = Buffer.alloc(30);
  header.write('PK', 0, 'latin1');
  header[2] = 0x03;
  header[3] = 0x04;
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(method, 8);
  header.writeUInt32LE(0, 14); // crc, which nothing here checks
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(raw.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28); // extra length
  return Buffer.concat([header, nameBuf, data]);
};

const contentTypes = mainPart => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + `<Override PartName="/main.xml" ContentType="${mainPart}"/></Types>`;

const ooxml = (mainPart, method) => zipEntry('[Content_Types].xml', contentTypes(mainPart), method);

const OOXML_PREFIX = 'application/vnd.openxmlformats-officedocument.';
const DOCX = ooxml(`${OOXML_PREFIX}wordprocessingml.document.main+xml`);
const XLSX = ooxml(`${OOXML_PREFIX}spreadsheetml.sheet.main+xml`);
const PPTX = ooxml(`${OOXML_PREFIX}presentationml.presentation.main+xml`);
const DOCX_STORED = ooxml(`${OOXML_PREFIX}wordprocessingml.document.main+xml`, 0);
const DOCM = ooxml('application/vnd.ms-word.document.macroEnabled.main+xml');
const ZIP_PLAIN = zipEntry('notes.txt', 'hello world');
const ODT = zipEntry('mimetype', 'application/vnd.oasis.opendocument.text', 0);

const OLE2 = Buffer.concat([bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), Buffer.alloc(512)]);
const PLAIN_TEXT = Buffer.from('CONSENT FORM\nI agree to take part in this study.\n', 'latin1');

const HTML = Buffer.from('<!DOCTYPE html><script>alert(1)</script>', 'latin1');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'latin1');

describe('media.core', () => {
  // =========================================================================
  // hashContent — dedupe DETECTION only, never identity
  // =========================================================================
  describe('hashContent', () => {
    it('produces the sha256 hex digest of the bytes', () => {
      // Pinned vector: this value ends up in a UNIQUE (userid, content_hash)
      // column, so changing the algorithm silently stops deduping.
      hashContent(Buffer.from('hello world'))
        .should.equal('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    });

    it('gives identical bytes an identical hash regardless of any other context', () => {
      // This is the whole dedupe mechanism: two uploads of the same file, from
      // different filenames, must collide.
      hashContent(Buffer.from([1, 2, 3])).should.equal(hashContent(Buffer.from([1, 2, 3])));
    });

    it('gives different bytes a different hash', () => {
      hashContent(Buffer.from([1, 2, 3])).should.not.equal(hashContent(Buffer.from([1, 2, 4])));
    });

    it('rejects non-Buffer input rather than hashing a coerced string', () => {
      (() => hashContent('hello world')).should.throw(TypeError);
    });
  });

  // =========================================================================
  // storageKeyFor / publicUrlFor — derived, never stored
  // =========================================================================
  describe('storageKeyFor', () => {
    it('derives the object key from the asset id alone, with no filename', () => {
      storageKeyFor(UUID).should.equal(`a/${UUID}`);
    });

    it('normalises to lowercase so one asset can never occupy two keys', () => {
      storageKeyFor(UUID.toUpperCase()).should.equal(`a/${UUID}`);
    });

    [
      ['path traversal', '../../../etc/passwd'],
      ['a key with a slash', `${UUID}/evil`],
      ['a non-uuid', 'not-a-uuid'],
      ['an empty string', ''],
      ['a non-string', null],
    ].forEach(([name, input]) => {
      it(`refuses to build a key from ${name}`, () => {
        // The uuid check is the only thing standing between a caller and an
        // object key outside the a/ prefix.
        (() => storageKeyFor(input)).should.throw(TypeError);
      });
    });
  });

  describe('publicUrlFor', () => {
    it('builds <base>/a/<uuid>/<filename>', () => {
      publicUrlFor(BASE, UUID, 'welcome.png').should.equal(`${BASE}/a/${UUID}/welcome.png`);
    });

    it('omits the filename segment when there is no usable filename', () => {
      publicUrlFor(BASE, UUID, null).should.equal(`${BASE}/a/${UUID}`);
    });

    it('does not double the slash when the base has a trailing one', () => {
      publicUrlFor(`${BASE}/`, UUID, 'welcome.png').should.equal(`${BASE}/a/${UUID}/welcome.png`);
    });

    it('strips path context from the filename so it can only ever be one segment', () => {
      publicUrlFor(BASE, UUID, '../../etc/passwd').should.equal(`${BASE}/a/${UUID}/passwd`);
    });

    it('percent-encodes a filename so spaces and delimiters cannot alter the path', () => {
      publicUrlFor(BASE, UUID, 'my file?x#y.png')
        .should.equal(`${BASE}/a/${UUID}/my%20file%3Fx%23y.png`);
    });

    it('fails loudly when the public base is not configured', () => {
      // A missing MEDIA_PUBLIC_BASE must not silently yield a relative URL that
      // gets pasted into a survey and delivered to respondents.
      (() => publicUrlFor('', UUID, 'welcome.png')).should.throw(TypeError);
      (() => publicUrlFor(undefined, UUID, 'welcome.png')).should.throw(TypeError);
    });

    it('round-trips through parseAssetId, including awkward filenames', () => {
      // The two halves of the URL contract live in this file; if they ever
      // disagree, every dashboard-uploaded asset silently sends by URL.
      ['welcome.png', 'my file (2).pdf', 'ünïcodé.jpg', '../evil', null].forEach(filename => {
        parseAssetId(publicUrlFor(BASE, UUID, filename)).should.equal(UUID);
      });
    });
  });

  // =========================================================================
  // parseAssetId — mirrors message-worker/mediaresolve.ParseAssetID
  // =========================================================================
  describe('parseAssetId', () => {
    // This table is the JS twin of TestParseAssetID in
    // message-worker/mediaresolve/mediaresolve_test.go. The two parsers decide
    // the same question on two sides of the system; they must not drift, so the
    // cases are kept identical on purpose.
    const accepted = [
      ['canonical asset url with filename', `${BASE}/a/${UUID}/welcome.png`],
      ['asset url without filename', `${BASE}/a/${UUID}`],
      ['trailing slash', `${BASE}/a/${UUID}/`],
      // Host-independent by design: a production URL in a survey running on
      // staging must parse, miss the local lookup, and send the prod URL.
      ['different host still parses', `https://media.staging.vlab.digital/a/${UUID}/welcome.png`],
      ['http scheme', `http://localhost:8080/a/${UUID}`],
      ['query string is ignored', `${BASE}/a/${UUID}/welcome.png?v=2`],
      ['fragment is ignored', `${BASE}/a/${UUID}#top`],
      // The filename segment is cosmetic: two URLs differing only there are the
      // same asset.
      ['filename is ignored entirely', `${BASE}/a/${UUID}/anything-at-all.pdf`],
      ['uppercase uuid normalises to lowercase', `${BASE}/a/550E8400-E29B-41D4-A716-446655440000`],
      // The shape the media-proxy sees. The same parser must accept it.
      ['bare path with no scheme or host', `/a/${UUID}/welcome.png`],
    ];

    accepted.forEach(([name, url]) => {
      it(`accepts: ${name}`, () => {
        should.equal(parseAssetId(url), UUID);
      });
    });

    const rejected = [
      ['third party url', 'https://i.imgur.com/ZSHauqq.png'],
      ['third party url containing a-slash', 'https://example.com/a/photo.png'],
      ['wrong prefix', `${BASE}/b/${UUID}`],
      ['no prefix', `${BASE}/${UUID}`],
      ['malformed uuid', `${BASE}/a/not-a-uuid`],
      ['uuid missing a group', `${BASE}/a/550e8400-e29b-41d4-a716`],
      ['uuid with non-hex characters', `${BASE}/a/550e8400-e29b-41d4-a716-44665544zzzz`],
      ['extra path segments', `${BASE}/a/${UUID}/a/b`],
      ['traversal attempt', `${BASE}/a/${UUID}/../../etc/passwd`],
      ['prefix nested deeper', `${BASE}/x/a/${UUID}`],
      ['empty string', ''],
      ['host with no path', BASE],
      ['not a url', 'just some text'],
      ['non-string input', null],
    ];

    rejected.forEach(([name, url]) => {
      it(`rejects: ${name}`, () => {
        // Every rejection is a URL we send as-is, with no lookup — never an error.
        should.equal(parseAssetId(url), null);
      });
    });
  });

  // =========================================================================
  // sniffContentType — never trust the client
  // =========================================================================
  describe('sniffContentType', () => {
    [
      ['jpeg', JPEG, undefined, 'image/jpeg'],
      ['png', PNG, undefined, 'image/png'],
      ['gif', GIF, undefined, 'image/gif'],
      ['webp', WEBP, undefined, 'image/webp'],
      ['wav', WAV, undefined, 'audio/wav'],
      ['pdf', PDF, undefined, 'application/pdf'],
      ['mp4', MP4, undefined, 'video/mp4'],
      ['quicktime', MOV, undefined, 'video/quicktime'],
      ['3gpp', THREEGP, undefined, 'video/3gpp'],
      ['m4a brand', M4A, undefined, 'audio/mp4'],
      ['mp3 with an id3 tag', MP3_ID3, undefined, 'audio/mpeg'],
      ['bare mp3 frame', MP3_FRAME, undefined, 'audio/mpeg'],
      ['ogg', OGG, undefined, 'audio/ogg'],
      ['amr', AMR, undefined, 'audio/amr'],
      ['webm', WEBM, undefined, 'video/webm'],
      ['docx, from the package manifest', DOCX, undefined, `${OOXML_PREFIX}wordprocessingml.document`],
      ['xlsx, from the package manifest', XLSX, undefined, `${OOXML_PREFIX}spreadsheetml.sheet`],
      ['pptx, from the package manifest', PPTX, undefined, `${OOXML_PREFIX}presentationml.presentation`],
      ['a stored (uncompressed) docx', DOCX_STORED, undefined, `${OOXML_PREFIX}wordprocessingml.document`],
    ].forEach(([name, buffer, claimed, want]) => {
      it(`identifies ${name} from its magic bytes`, () => {
        sniffContentType(buffer, claimed).should.equal(want);
      });
    });

    it('ignores a wrong claim when the bytes are recognisable', () => {
      sniffContentType(JPEG, 'image/gif').should.equal('image/jpeg');
      sniffContentType(PDF, 'image/png').should.equal('application/pdf');
    });

    it('refuses to identify an html payload, whatever it claims to be', () => {
      // The serve-time Content-Type comes from here. Believing "image/png" for
      // these bytes would serve executable HTML from our own domain.
      sniffContentType(HTML, 'image/png').should.equal(OCTET_STREAM);
      sniffContentType(SVG, 'image/svg+xml').should.equal(OCTET_STREAM);
    });

    it('lets a claim narrow within a container, but never widen trust', () => {
      // An ftyp box cannot distinguish an audio-only mp4 from a video one, so
      // the claim is allowed to refine the result — inside the same container.
      sniffContentType(MP4, 'audio/mp4').should.equal('audio/mp4');
      sniffContentType(WEBM, 'audio/webm').should.equal('audio/webm');
      // …but an unrecognised container is not rescued by any claim.
      sniffContentType(Buffer.from('plain text'), 'application/pdf').should.equal(OCTET_STREAM);
    });

    it('does not accept a RIFF container it cannot name', () => {
      sniffContentType(withAscii([], 'RIFF\x00\x00\x00\x00AVI LIST'), 'video/x-msvideo')
        .should.equal(OCTET_STREAM);
    });

    // A ZIP is a container, not a format. docx/xlsx/pptx are identified by the
    // content type the package declares for its own main part — never by the
    // filename, the extension or the claimed type.
    describe('zip containers', () => {
      it('names a zip it cannot resolve to an OOXML document as a plain zip', () => {
        // Named rather than octet-stream, so the error can say "ZIP archive" —
        // but not accepted, because "a zip" is not a sendable document type.
        sniffContentType(ZIP_PLAIN, 'application/zip').should.equal('application/zip');
      });

      it('does not treat an OpenDocument file as an OOXML one', () => {
        sniffContentType(ODT, 'application/vnd.oasis.opendocument.text')
          .should.equal('application/zip');
      });

      it('does not resolve a macro-enabled package, whose main part differs', () => {
        // docm/xlsm/pptm carry executable content and are not on Meta's list.
        // Matching the exact ".main+xml" part type is what excludes them; a
        // "does it contain word/" heuristic would have let them through.
        sniffContentType(DOCM, 'application/vnd.ms-word.document.macroEnabled.12')
          .should.equal('application/zip');
      });

      it('does not let a claimed docx rescue a zip that is not one', () => {
        sniffContentType(ZIP_PLAIN, `${OOXML_PREFIX}wordprocessingml.document`)
          .should.equal('application/zip');
      });

      it('survives a truncated zip rather than throwing', () => {
        sniffContentType(DOCX.slice(0, 20), undefined).should.equal('application/zip');
        sniffContentType(DOCX.slice(0, 45), undefined).should.equal('application/zip');
      });

      it('survives a zip whose deflate stream is corrupt', () => {
        const corrupt = Buffer.from(DOCX);
        corrupt.fill(0xff, corrupt.length - 8);
        sniffContentType(corrupt, undefined).should.equal('application/zip');
      });
    });

    it('names an OLE2 compound file but does not guess which Office type it is', () => {
      // The magic identifies the container; .doc, .xls, .ppt, .msi and .msg all
      // share it. Which one requires walking the CFB directory, so it stays
      // unnamed and unaccepted rather than being guessed from the extension.
      sniffContentType(OLE2, 'application/msword').should.equal('application/x-ole-storage');
    });

    it('never identifies plain text, whatever the client claims', () => {
      // DELIBERATE (§11.5): text/plain has no magic bytes, so "is this text?"
      // cannot be answered. Every HTML and SVG payload the octet-stream
      // rejection exists to catch is also plain text.
      sniffContentType(PLAIN_TEXT, 'text/plain').should.equal(OCTET_STREAM);
    });

    it('returns octet-stream for empty or non-buffer input', () => {
      sniffContentType(Buffer.alloc(0), 'image/png').should.equal(OCTET_STREAM);
      sniffContentType(null, 'image/png').should.equal(OCTET_STREAM);
    });
  });

  // =========================================================================
  // validateUpload
  // =========================================================================
  describe('validateUpload', () => {
    const upload = (buffer, originalname, mimetype) => ({ buffer, originalname, mimetype });

    it('accepts a real image and reports server-determined facts', () => {
      validateUpload(upload(PNG, 'welcome.png', 'image/png')).should.deep.equal({
        ok: true,
        filename: 'welcome.png',
        mimeType: 'image/png',
        mediaType: 'image',
        byteSize: PNG.length,
      });
    });

    it('reports the sniffed type, not the claimed one', () => {
      // A researcher's browser mislabels files routinely; a malicious client
      // does it on purpose. Either way the bytes decide.
      const result = validateUpload(upload(JPEG, 'photo.png', 'image/gif'));
      result.ok.should.equal(true);
      result.mimeType.should.equal('image/jpeg');
    });

    it('takes byteSize from the bytes, ignoring a lying size field', () => {
      const file = upload(PNG, 'welcome.png', 'image/png');
      file.size = 5; // multer's number, not to be trusted
      validateUpload(file).byteSize.should.equal(PNG.length);
    });

    it('rejects an html payload disguised as an image', () => {
      const result = validateUpload(upload(HTML, 'welcome.png', 'image/png'));
      result.ok.should.equal(false);
      result.error.should.include('not supported');
    });

    it('rejects an svg, which is a script container', () => {
      validateUpload(upload(SVG, 'logo.svg', 'image/svg+xml')).ok.should.equal(false);
    });

    it('derives media_type from the resolved mime type', () => {
      validateUpload(upload(MP4, 'clip.mp4', 'video/mp4')).mediaType.should.equal('video');
      validateUpload(upload(MP3_ID3, 'voice.mp3', 'audio/mpeg')).mediaType.should.equal('audio');
      validateUpload(upload(PDF, 'consent.pdf', 'application/pdf')).mediaType.should.equal('file');
    });

    it('strips path context from the uploaded filename', () => {
      validateUpload(upload(PNG, '../../etc/passwd.png', 'image/png')).filename
        .should.equal('passwd.png');
    });

    it('rejects a filename that sanitises away to nothing', () => {
      const result = validateUpload(upload(PNG, '..', 'image/png'));
      result.ok.should.equal(false);
      result.error.should.include('filename');
    });

    it('rejects a missing file', () => {
      validateUpload(null).should.deep.equal({ ok: false, error: 'file is required' });
    });

    it('rejects an empty file', () => {
      const result = validateUpload(upload(Buffer.alloc(0), 'empty.png', 'image/png'));
      result.ok.should.equal(false);
      result.error.should.include('empty');
    });

    it('rejects a PNG larger than the 5 MB image limit', () => {
      const big = Buffer.allocUnsafe(MEDIA_TYPE_LIMITS.image.maxBytes + 1);
      // Fill it with PNG magic bytes so it sniffs as PNG.
      PNG.copy(big);
      const result = validateUpload(upload(big, 'huge.png', 'image/png'));
      result.ok.should.equal(false);
      result.error.should.include('MB');
      result.error.should.include('5');
    });

    // ===== New test suite: per-type limits and error messages =====

    describe('per-media-type limits and error messages', () => {
      // Boundary tests: exactly at limit passes, one byte over fails
      describe('boundary tests for size limits', () => {
        it('accepts a PNG exactly at the 5 MB image limit', () => {
          const atLimit = Buffer.allocUnsafe(MEDIA_TYPE_LIMITS.image.maxBytes);
          PNG.copy(atLimit);
          const result = validateUpload(upload(atLimit, 'photo.png', 'image/png'));
          result.ok.should.equal(true);
        });

        it('rejects a PNG one byte over the 5 MB image limit', () => {
          const overLimit = Buffer.allocUnsafe(MEDIA_TYPE_LIMITS.image.maxBytes + 1);
          PNG.copy(overLimit);
          const result = validateUpload(upload(overLimit, 'photo.png', 'image/png'));
          result.ok.should.equal(false);
          result.error.should.include('5.0 MB');
        });

        it('accepts an MP4 exactly at the 16 MB video limit', () => {
          const atLimit = Buffer.allocUnsafe(MEDIA_TYPE_LIMITS.video.maxBytes);
          withAscii([0, 0, 0, 0x20], 'ftypisom   ').copy(atLimit);
          const result = validateUpload(upload(atLimit, 'clip.mp4', 'video/mp4'));
          result.ok.should.equal(true);
        });

        it('rejects an MP4 one byte over the 16 MB video limit', () => {
          const overLimit = Buffer.allocUnsafe(MEDIA_TYPE_LIMITS.video.maxBytes + 1);
          withAscii([0, 0, 0, 0x20], 'ftypisom   ').copy(overLimit);
          const result = validateUpload(upload(overLimit, 'clip.mp4', 'video/mp4'));
          result.ok.should.equal(false);
          result.error.should.include('16.0 MB');
        });

        it('accepts an MP3 exactly at the 16 MB audio limit', () => {
          const atLimit = Buffer.allocUnsafe(MEDIA_TYPE_LIMITS.audio.maxBytes);
          Buffer.from('ID3      ').copy(atLimit);
          const result = validateUpload(upload(atLimit, 'song.mp3', 'audio/mpeg'));
          result.ok.should.equal(true);
        });

        it('rejects an MP3 one byte over the 16 MB audio limit', () => {
          const overLimit = Buffer.allocUnsafe(MEDIA_TYPE_LIMITS.audio.maxBytes + 1);
          Buffer.from('ID3      ').copy(overLimit);
          const result = validateUpload(upload(overLimit, 'song.mp3', 'audio/mpeg'));
          result.ok.should.equal(false);
          result.error.should.include('16.0 MB');
        });

        it('accepts a PDF exactly at the 100 MB document limit', () => {
          const atLimit = Buffer.allocUnsafe(MEDIA_TYPE_LIMITS.file.maxBytes);
          Buffer.from('%PDF-1.7\n').copy(atLimit);
          const result = validateUpload(upload(atLimit, 'document.pdf', 'application/pdf'));
          result.ok.should.equal(true);
        });

        it('rejects a PDF one byte over the 100 MB document limit', () => {
          const overLimit = Buffer.allocUnsafe(MEDIA_TYPE_LIMITS.file.maxBytes + 1);
          Buffer.from('%PDF-1.7\n').copy(overLimit);
          const result = validateUpload(upload(overLimit, 'document.pdf', 'application/pdf'));
          result.ok.should.equal(false);
          result.error.should.include('100.0 MB');
        });
      });

      describe('unsupported type error messages name rejected type and alternatives', () => {
        it('GIF is rejected with accepted image alternatives', () => {
          const result = validateUpload(upload(GIF, 'photo.gif', 'image/gif'));
          result.ok.should.equal(false);
          result.error.should.include('GIF');
          result.error.should.include('JPEG');
          result.error.should.include('PNG');
        });

        it('WebP is rejected with accepted image alternatives', () => {
          const result = validateUpload(upload(WEBP, 'photo.webp', 'image/webp'));
          result.ok.should.equal(false);
          result.error.should.include('WebP');
          result.error.should.include('JPEG');
          result.error.should.include('PNG');
        });

        it('QuickTime is rejected with accepted video alternatives', () => {
          const result = validateUpload(upload(MOV, 'clip.mov', 'video/quicktime'));
          result.ok.should.equal(false);
          result.error.should.include('QuickTime');
          result.error.should.include('MP4');
          result.error.should.include('3GPP');
        });

        it('WebM video is rejected with accepted video alternatives', () => {
          const webmVideo = WEBM;
          const result = validateUpload(upload(webmVideo, 'clip.webm', 'video/webm'));
          result.ok.should.equal(false);
          result.error.should.include('WebM');
          result.error.should.include('MP4');
        });

        it('WAV is rejected with accepted audio alternatives', () => {
          const result = validateUpload(upload(WAV, 'sound.wav', 'audio/wav'));
          result.ok.should.equal(false);
          result.error.should.include('WAV');
          // Should list the accepted audio formats
          (result.error.includes('MPEG') || result.error.includes('AAC') || result.error.includes('AMR'))
            .should.equal(true);
        });
      });

      describe('size check uses sniffed type, not claimed type', () => {
        it('applies video limit to a file that claims to be image/png but sniffs as MP4', () => {
          // Construct an MP4 but claim it is PNG
          const mp4 = withAscii([0, 0, 0, 0x20], 'ftypisom   ');
          // Make it just over the image limit but under the video limit
          const justOverImageLimit = Buffer.allocUnsafe(MEDIA_TYPE_LIMITS.image.maxBytes + 100000);
          mp4.copy(justOverImageLimit);
          const result = validateUpload(upload(justOverImageLimit, 'file.png', 'image/png'));
          // It should pass because the video limit is higher, and sniffing decides it is video
          result.ok.should.equal(true);
          result.mimeType.should.equal('video/mp4');
        });

        it('applies image limit to a file that claims to be video/mp4 but sniffs as PNG', () => {
          // Construct a PNG but claim it is MP4
          const png = PNG;
          // Make it just over the image limit
          const justOverImageLimit = Buffer.allocUnsafe(MEDIA_TYPE_LIMITS.image.maxBytes + 100000);
          png.copy(justOverImageLimit);
          const result = validateUpload(upload(justOverImageLimit, 'file.mp4', 'video/mp4'));
          // It should fail because it sniffs as PNG (image limit is 5MB) despite claiming to be video
          result.ok.should.equal(false);
          result.error.should.include('5.0 MB');
        });
      });

      describe('oversize error message includes human-readable sizes', () => {
        it('formats a 6.2 MB PNG as "image is 6.2 MB, maximum is 5.0 MB"', () => {
          const sixMB = Buffer.allocUnsafe(6 * 1024 * 1024 + 200 * 1024);
          PNG.copy(sixMB);
          const result = validateUpload(upload(sixMB, 'photo.png', 'image/png'));
          result.ok.should.equal(false);
          result.error.should.include('6.2');
          result.error.should.include('5.0');
        });
      });

      describe('formerly-allowed, now-rejected types', () => {
        it('GIF is no longer allowed (regression test)', () => {
          const result = validateUpload(upload(GIF, 'photo.gif', 'image/gif'));
          result.ok.should.equal(false);
          ALLOWED_MIME_TYPES.should.not.include('image/gif');
        });

        it('WebP is no longer allowed (regression test)', () => {
          const result = validateUpload(upload(WEBP, 'photo.webp', 'image/webp'));
          result.ok.should.equal(false);
          ALLOWED_MIME_TYPES.should.not.include('image/webp');
        });

        it('QuickTime is no longer allowed (regression test)', () => {
          const result = validateUpload(upload(MOV, 'clip.mov', 'video/quicktime'));
          result.ok.should.equal(false);
          ALLOWED_MIME_TYPES.should.not.include('video/quicktime');
        });

        it('WebM is no longer allowed (regression test)', () => {
          const result = validateUpload(upload(WEBM, 'clip.webm', 'video/webm'));
          result.ok.should.equal(false);
          ALLOWED_MIME_TYPES.should.not.include('video/webm');
        });

        it('WAV is no longer allowed (regression test)', () => {
          const result = validateUpload(upload(WAV, 'sound.wav', 'audio/wav'));
          result.ok.should.equal(false);
          ALLOWED_MIME_TYPES.should.not.include('audio/wav');
        });
      });

      // Meta supports eight document MIME types (§11.5). We accept the four the
      // sniffer can positively identify, and refuse the rest by name rather than
      // trusting an extension.
      describe('document types beyond PDF', () => {
        [
          ['docx', DOCX, 'consent.docx', `${OOXML_PREFIX}wordprocessingml.document`],
          ['xlsx', XLSX, 'roster.xlsx', `${OOXML_PREFIX}spreadsheetml.sheet`],
          ['pptx', PPTX, 'briefing.pptx', `${OOXML_PREFIX}presentationml.presentation`],
        ].forEach(([name, buffer, filename, mimeType]) => {
          it(`accepts a ${name} identified from its package manifest`, () => {
            validateUpload(upload(buffer, filename, mimeType)).should.deep.equal({
              ok: true,
              filename,
              mimeType,
              mediaType: 'file',
              byteSize: buffer.length,
            });
          });
        });

        it('accepts a docx even when the client claims something else entirely', () => {
          // The bytes decide, in both directions: they can be trusted to accept
          // as well as to reject.
          const result = validateUpload(upload(DOCX, 'consent.docx', 'application/octet-stream'));
          result.ok.should.equal(true);
          result.mimeType.should.equal(`${OOXML_PREFIX}wordprocessingml.document`);
        });

        it('rejects a zip that is not an OOXML document, naming it and the alternatives', () => {
          const result = validateUpload(upload(ZIP_PLAIN, 'bundle.zip', 'application/zip'));
          result.ok.should.equal(false);
          result.error.should.include('ZIP');
          result.error.should.include('PDF');
          result.error.should.include('DOCX');
        });

        it('rejects a docx-claimed zip that is not one', () => {
          // The load-bearing rule: never fall back to the claimed type or the
          // extension when the bytes do not support it.
          validateUpload(upload(ZIP_PLAIN, 'consent.docx', `${OOXML_PREFIX}wordprocessingml.document`))
            .ok.should.equal(false);
        });

        it('rejects a macro-enabled package, which carries executable content', () => {
          validateUpload(upload(DOCM, 'consent.docm', 'application/vnd.ms-word.document.macroEnabled.12'))
            .ok.should.equal(false);
        });

        it('rejects a legacy Office document, naming the format it could not resolve', () => {
          // OLE2 identifies the container but not whether it is .doc, .xls or
          // .ppt — which is why these are refused rather than guessed at.
          const result = validateUpload(upload(OLE2, 'consent.doc', 'application/msword'));
          result.ok.should.equal(false);
          result.error.should.include('.doc');
          result.error.should.include('PDF');
          ALLOWED_MIME_TYPES.should.not.include('application/msword');
          ALLOWED_MIME_TYPES.should.not.include('application/vnd.ms-excel');
          ALLOWED_MIME_TYPES.should.not.include('application/vnd.ms-powerpoint');
        });

        it('refuses text/plain even when the client claims text/plain', () => {
          // DELIBERATE, not an oversight (§11.5). Meta lists text/plain as
          // supported, but text has no magic bytes: accepting it means accepting
          // any unidentifiable input, which is exactly what the octet-stream
          // rejection exists to catch. Removing this pin re-opens §4.6.
          const result = validateUpload(upload(PLAIN_TEXT, 'consent.txt', 'text/plain'));
          result.ok.should.equal(false);
          ALLOWED_MIME_TYPES.should.not.include('text/plain');
        });
      });

      // Meta: "Images must be 8-bit, RGB or RGBA." A 16-bit PNG passes every
      // size and MIME check and is then refused by WhatsApp at fan-out — an
      // asset that gets no handle and sends by URL forever, with nothing
      // erroring anywhere. Cheap to catch here: one byte at a fixed offset.
      describe('PNG bit depth', () => {
        it('accepts an 8-bit PNG', () => {
          validateUpload(upload(PNG, 'photo.png', 'image/png')).ok.should.equal(true);
        });

        it('accepts an 8-bit greyscale PNG — only the depth is enforced', () => {
          // Colour type is deliberately not gated: 8-bit greyscale and palette
          // PNGs are accepted in practice, and refusing them would cost
          // researchers real files for no observed gain.
          validateUpload(upload(PNG_GREY_8BIT, 'chart.png', 'image/png')).ok.should.equal(true);
        });

        it('rejects a 16-bit PNG with an error naming the actual depth', () => {
          const result = validateUpload(upload(PNG_16BIT, 'photo.png', 'image/png'));
          result.ok.should.equal(false);
          result.error.should.include('16-bit');
          result.error.should.include('8-bit');
        });

        it('rejects a 4-bit PNG, naming its depth too', () => {
          const result = validateUpload(upload(PNG_4BIT, 'icon.png', 'image/png'));
          result.ok.should.equal(false);
          result.error.should.include('4-bit');
        });

        it('rejects a PNG signature with no readable IHDR', () => {
          // Unknowable depth is treated like unknowable age in planReconcile:
          // we cannot show it is sendable, so it is not accepted.
          const result = validateUpload(upload(PNG_HEADERLESS, 'photo.png', 'image/png'));
          result.ok.should.equal(false);
          result.error.should.include('8-bit');
        });

        it('leaves JPEG alone — the depth check is PNG-specific', () => {
          validateUpload(upload(JPEG, 'photo.jpg', 'image/jpeg')).ok.should.equal(true);
        });
      });

    });
  });

  // =========================================================================
  // buildAssetRecord
  // =========================================================================
  describe('buildAssetRecord', () => {
    const meta = { filename: 'welcome.png', mimeType: 'image/png', mediaType: 'image', byteSize: 1234 };

    it('builds the media_asset row from server-determined facts', () => {
      buildAssetRecord('r@vlab.digital', 'abc123', meta).should.deep.equal({
        email: 'r@vlab.digital',
        contentHash: 'abc123',
        mediaType: 'image',
        mimeType: 'image/png',
        byteSize: 1234,
        filename: 'welcome.png',
      });
    });

    it('derives mediaType when it is not supplied', () => {
      buildAssetRecord('r@vlab.digital', 'abc123', { filename: 'clip.mp4', mimeType: 'video/mp4', byteSize: 9 })
        .mediaType.should.equal('video');
    });

    it('sanitises the filename it stores', () => {
      // The stored filename is what ends up in the public URL.
      buildAssetRecord('r@vlab.digital', 'abc123', { ...meta, filename: 'a/b/../c.png' })
        .filename.should.equal('c.png');
    });

    [
      ['a missing email', [null, 'abc123', meta]],
      ['a missing hash', ['r@vlab.digital', null, meta]],
      ['a missing mime type', ['r@vlab.digital', 'abc123', { filename: 'x.png' }]],
      ['a missing filename', ['r@vlab.digital', 'abc123', { mimeType: 'image/png' }]],
      ['missing meta entirely', ['r@vlab.digital', 'abc123', undefined]],
    ].forEach(([name, args]) => {
      it(`fails loudly on ${name}`, () => {
        (() => buildAssetRecord(...args)).should.throw(TypeError);
      });
    });
  });

  // =========================================================================
  // planReconcile — the reconciler's whole decision layer
  // =========================================================================
  describe('planReconcile', () => {
    const NOW = at('2026-08-09T12:00:00Z');
    const nowMs = NOW.getTime();

    // The SHIPPED TTLs, deliberately — not a local copy. These tests are the
    // regression pin for the constants themselves: a wrong TTL here does not
    // fail loudly anywhere, it just stops refreshing handles, and every send
    // quietly falls back to URL from then on.
    const POLICY = {
      ttlMs: DEFAULT_RECONCILE_POLICY.ttlMs,
      refreshMarginMs: DEFAULT_RECONCILE_POLICY.refreshMarginMs,
      prune: true,
    };
    const MARGIN = DEFAULT_RECONCILE_POLICY.refreshMarginMs;

    const USER = 'user-1';
    const ASSET = { id: UUID, userid: USER };
    const PAGE = { userid: USER, accountId: 'page-1', platform: 'messenger' };
    const NUMBER = { userid: USER, accountId: 'number-1', platform: 'whatsapp' };

    const handle = (accountId, over) => Object.assign({
      assetId: UUID,
      accountId,
      platformMediaId: 'mid-1',
      uploadedAt: new Date(nowMs - DAY),
      expiresAt: null,
    }, over);

    // Applies a plan the way the imperative shell will: create/refresh is an
    // upsert stamping uploaded_at = now, prune is a delete. Used to prove
    // idempotence — the property that makes it safe to run on a tick.
    const apply = (handles, actions, policy) => {
      const byKey = new Map(handles.map(h => [`${h.assetId}|${h.accountId}`, h]));
      for (const a of actions) {
        const key = `${a.assetId}|${a.accountId}`;
        if (a.type === 'prune') {
          byKey.delete(key);
          continue;
        }
        const ttl = (policy.ttlMs || {})[a.platform];
        byKey.set(key, {
          assetId: a.assetId,
          accountId: a.accountId,
          platformMediaId: 'fresh-id',
          uploadedAt: NOW,
          expiresAt: ttl ? new Date(nowMs + ttl) : null,
        });
      }
      return Array.from(byKey.values());
    };

    it('creates a handle for every account of the asset owner', () => {
      planReconcile(NOW, [ASSET], [PAGE, NUMBER], [], POLICY).should.deep.equal([
        { type: 'create', assetId: UUID, accountId: 'page-1', platform: 'messenger', reason: 'missing' },
        { type: 'create', assetId: UUID, accountId: 'number-1', platform: 'whatsapp', reason: 'missing' },
      ]);
    });

    it('does nothing when every account already has a live handle', () => {
      const handles = [handle('page-1'), handle('number-1', { expiresAt: new Date(nowMs + 29 * DAY) })];
      planReconcile(NOW, [ASSET], [PAGE, NUMBER], handles, POLICY).should.deep.equal([]);
    });

    it('backfills only the newly connected account', () => {
      // The researcher connected a second account after uploading. No
      // credential-creation hook exists; the next tick is what fixes it.
      const actions = planReconcile(NOW, [ASSET], [PAGE, NUMBER], [handle('page-1')], POLICY);
      actions.should.deep.equal([
        { type: 'create', assetId: UUID, accountId: 'number-1', platform: 'whatsapp', reason: 'missing' },
      ]);
    });

    it('never touches another researcher\'s accounts', () => {
      const other = { userid: 'user-2', accountId: 'page-99', platform: 'messenger' };
      planReconcile(NOW, [ASSET], [PAGE, other], [], POLICY)
        .map(a => a.accountId).should.deep.equal(['page-1']);
    });

    it('refreshes a handle whose row records it as dead', () => {
      // platform_media_id IS NULL means a previous attempt failed. It is not a
      // handle, so the reconciler must try again rather than leave it forever.
      const actions = planReconcile(NOW, [ASSET], [NUMBER], [handle('number-1', { platformMediaId: null })], POLICY);
      actions.should.deep.equal([
        { type: 'refresh', assetId: UUID, accountId: 'number-1', platform: 'whatsapp', reason: 'dead' },
      ]);
    });

    describe('expiry, decided by the injected clock', () => {
      const plan = expiresAt => planReconcile(
        NOW, [ASSET], [NUMBER], [handle('number-1', { expiresAt })], POLICY,
      );

      it('refreshes a handle already past its expiry', () => {
        plan(new Date(nowMs - MINUTE)).map(a => a.reason).should.deep.equal(['expiring']);
      });

      it('refreshes a handle inside the margin', () => {
        plan(new Date(nowMs + 2 * DAY)).map(a => a.reason).should.deep.equal(['expiring']);
      });

      it('refreshes a handle exactly at the margin boundary', () => {
        // The boundary refreshes deliberately: an unnecessary re-upload costs a
        // request, a missed one costs a handle the worker is still using.
        plan(new Date(nowMs + 3 * DAY)).map(a => a.reason).should.deep.equal(['expiring']);
      });

      it('leaves a handle one millisecond past the margin alone', () => {
        plan(new Date(nowMs + 3 * DAY + 1)).should.deep.equal([]);
      });

      it('accepts expires_at as an ISO string, as the database returns it', () => {
        plan('2026-08-10T12:00:00.000Z').map(a => a.reason).should.deep.equal(['expiring']);
      });
    });

    describe('age, decided by uploaded_at and never by last use', () => {
      // Meta's reference says 30 days from upload; third-party docs claim 30
      // days from last use. From-upload is the stricter of the two, so a
      // reconciler built on it is correct under both — and it means a handle
      // nobody has sent recently is still refreshed on schedule.
      const plan = (uploadedAt, account = NUMBER) => planReconcile(
        NOW, [ASSET], [account], [handle(account.accountId, { uploadedAt, expiresAt: null })], POLICY,
      );

      it('refreshes a handle whose uploaded_at puts it inside the margin', () => {
        plan(new Date(nowMs - 28 * DAY)).map(a => a.reason).should.deep.equal(['expiring']);
      });

      it('leaves a young handle alone', () => {
        plan(new Date(nowMs - 20 * DAY)).should.deep.equal([]);
      });

      it('refreshes a handle with an unknowable age', () => {
        // No expires_at and no uploaded_at on a platform that does expire: we
        // cannot show it is fresh, so treat it as stale.
        plan(null).map(a => a.reason).should.deep.equal(['expiring']);
      });

      // Messenger attachment ids expire after 90 days — Meta documents it, and
      // this table said "never" until 2026-08-10 (§11.2). The consequence of
      // that bug is the reason these four tests exist: with no TTL, no Messenger
      // handle is ever refreshed, every one dies at 90 days, and because a
      // handle is only an optimisation, nothing errors — every send falls back
      // to URL forever, silently, on the platform carrying ~100% of live media
      // traffic (§11.1). Messenger handles age out like any other.
      describe('Messenger, which expires at 90 days like any other platform', () => {
        const messenger = uploadedAt => plan(uploadedAt, PAGE);
        const TTL = 90 * DAY;

        it('refreshes a Messenger handle older than 90 days', () => {
          messenger(new Date(nowMs - 91 * DAY)).map(a => a.reason).should.deep.equal(['expiring']);
        });

        it('leaves a Messenger handle well inside 90 days alone', () => {
          messenger(new Date(nowMs - 60 * DAY)).should.deep.equal([]);
        });

        it('refreshes exactly at the margin, one full tick before death', () => {
          messenger(new Date(nowMs - (TTL - MARGIN))).map(a => a.reason).should.deep.equal(['expiring']);
        });

        it('leaves a handle one millisecond younger than the margin alone', () => {
          messenger(new Date(nowMs - (TTL - MARGIN) + 1)).should.deep.equal([]);
        });
      });
    });

    it('matches handles on account_id alone, ignoring the platform spelling', () => {
      // The regression this design exists to prevent: credentials say
      // 'facebook_page', SendMessageCommand says 'messenger'. If the platform
      // participated in the match, this row would look absent, the reconciler
      // would re-upload on every tick, and nothing would ever report an error.
      const stored = handle('page-1');
      stored.platform = 'facebook_page';
      planReconcile(NOW, [ASSET], [PAGE], [stored], POLICY).should.deep.equal([]);
    });

    it('canonicalises the platform it reports for an action', () => {
      // Accounts arrive straight off credentials rows, holding entity spellings.
      const credential = { userid: USER, key: 'page-1', entity: 'facebook_page' };
      planReconcile(NOW, [ASSET], [credential], [], POLICY)
        .should.deep.equal([
          { type: 'create', assetId: UUID, accountId: 'page-1', platform: 'messenger', reason: 'missing' },
        ]);
    });

    it('reads handles supplied as raw snake_case database rows', () => {
      // A shape mismatch here would present as "this asset has no handles",
      // which is a silent, expensive, permanent re-upload loop.
      const row = {
        asset_id: UUID,
        account_id: 'number-1',
        platform: 'whatsapp',
        platform_media_id: 'mid-1',
        uploaded_at: new Date(nowMs - DAY),
        expires_at: new Date(nowMs + 29 * DAY),
      };
      planReconcile(NOW, [ASSET], [NUMBER], [row], POLICY).should.deep.equal([]);
    });

    it('matches assets and handles case-insensitively on the uuid', () => {
      const stored = handle('page-1', { assetId: UUID.toUpperCase() });
      planReconcile(NOW, [{ id: UUID.toUpperCase(), userid: USER }], [PAGE], [stored], POLICY)
        .should.deep.equal([]);
    });

    describe('pruning', () => {
      it('prunes a handle for an account the owner no longer has', () => {
        const stale = handle('page-gone');
        planReconcile(NOW, [ASSET], [PAGE], [handle('page-1'), stale], POLICY).should.deep.equal([
          { type: 'prune', assetId: UUID, accountId: 'page-gone', platform: null, reason: 'account_disconnected' },
        ]);
      });

      it('can be turned off without affecting the other decisions', () => {
        const policy = { ...POLICY, prune: false };
        planReconcile(NOW, [ASSET], [PAGE], [handle('page-gone')], policy).should.deep.equal([
          { type: 'create', assetId: UUID, accountId: 'page-1', platform: 'messenger', reason: 'missing' },
        ]);
      });

      it('ignores handles for assets outside the batch', () => {
        // Reconciling a page of assets must not delete handles belonging to the
        // assets it was not asked about.
        const otherAsset = handle('page-1', { assetId: '11111111-2222-3333-4444-555555555555' });
        planReconcile(NOW, [ASSET], [PAGE], [handle('page-1'), otherAsset], POLICY)
          .should.deep.equal([]);
      });
    });

    it('is idempotent: applying the plan and re-running produces nothing', () => {
      const accounts = [PAGE, NUMBER];
      const before = [
        handle('page-1', { platformMediaId: null }),            // dead   -> refresh
        handle('number-1', { expiresAt: new Date(nowMs + DAY) }), // expiring -> refresh
        handle('page-gone'),                                     // orphan -> prune
      ];
      const first = planReconcile(NOW, [ASSET], accounts, before, POLICY);
      first.map(a => a.type).should.deep.equal(['refresh', 'refresh', 'prune']);

      const after = apply(before, first, POLICY);
      planReconcile(NOW, [ASSET], accounts, after, POLICY).should.deep.equal([]);
    });

    it('is idempotent from empty state too', () => {
      const accounts = [PAGE, NUMBER];
      const first = planReconcile(NOW, [ASSET], accounts, [], POLICY);
      const after = apply([], first, POLICY);
      planReconcile(NOW, [ASSET], accounts, after, POLICY).should.deep.equal([]);
    });

    it('plans every asset in the batch', () => {
      const second = { id: '11111111-2222-3333-4444-555555555555', userid: USER };
      planReconcile(NOW, [ASSET, second], [PAGE], [], POLICY)
        .map(a => a.assetId).should.deep.equal([UUID, second.id]);
    });

    it('returns nothing for an owner with no messaging accounts', () => {
      // §3: a researcher can upload before connecting any account. That must be
      // a no-op here, not an error.
      planReconcile(NOW, [ASSET], [], [], POLICY).should.deep.equal([]);
    });

    it('returns nothing for empty or missing inputs', () => {
      planReconcile(NOW, [], [], [], POLICY).should.deep.equal([]);
      planReconcile(NOW, null, null, null, POLICY).should.deep.equal([]);
    });

    it('fails loudly without a clock rather than silently using the wall time', () => {
      (() => planReconcile(undefined, [ASSET], [PAGE], [], POLICY)).should.throw(TypeError);
    });

    it('accepts the clock as epoch milliseconds', () => {
      planReconcile(nowMs, [ASSET], [PAGE], [handle('page-1')], POLICY).should.deep.equal([]);
    });
  });
});

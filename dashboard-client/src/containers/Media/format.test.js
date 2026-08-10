import {
  formatBytes, parseApiError, mergeAsset, isPreviewable,
} from './format';

// The API client throws `new Error(await res.text())`, so an error thrown out
// of a failed upload carries the raw response body as its message.
const thrownBy = body => new Error(body);

describe('parseApiError — the server\'s refusal, verbatim', () => {
  // planning/media-abstraction.md §11.5: we refuse ineligible files instead of
  // transcoding them, and the refusal names the problem AND the fix. If these
  // strings ever get collapsed into "upload failed", that decision stops
  // working: the researcher is left with a file they cannot fix.
  it('surfaces an over-size refusal exactly as the server wrote it', () => {
    const err = thrownBy(JSON.stringify({ error: 'image is 6.2 MB, maximum is 5.0 MB' }));
    expect(parseApiError(err)).toBe('image is 6.2 MB, maximum is 5.0 MB');
  });

  it('surfaces an unsupported-format refusal exactly as the server wrote it', () => {
    const err = thrownBy(JSON.stringify({ error: 'GIF is not supported; use JPEG or PNG' }));
    expect(parseApiError(err)).toBe('GIF is not supported; use JPEG or PNG');
  });

  it('never replaces a present server message with the fallback', () => {
    const err = thrownBy(JSON.stringify({ error: 'video is 40.0 MB, maximum is 16.0 MB' }));
    expect(parseApiError(err, 'Upload failed')).not.toBe('Upload failed');
  });

  it('reads a nested {error:{message}} shape rather than losing the text', () => {
    const err = thrownBy(JSON.stringify({ error: { message: 'token expired' } }));
    expect(parseApiError(err)).toBe('token expired');
  });

  it('reads a bare {message} shape', () => {
    expect(parseApiError(thrownBy(JSON.stringify({ message: 'nope' })))).toBe('nope');
  });

  it('passes a non-JSON body through — an HTML 502 page is still more specific than nothing', () => {
    expect(parseApiError(thrownBy('Bad Gateway'))).toBe('Bad Gateway');
  });

  it('passes a network error message through', () => {
    expect(parseApiError(new TypeError('Failed to fetch'))).toBe('Failed to fetch');
  });

  it('falls back only when there is genuinely no message', () => {
    expect(parseApiError(new Error(''), 'Upload failed')).toBe('Upload failed');
    expect(parseApiError(null, 'Upload failed')).toBe('Upload failed');
    expect(parseApiError(thrownBy('{}'), 'Upload failed')).toBe('Upload failed');
  });
});

describe('mergeAsset — the dedupe response must not duplicate a row', () => {
  // POST /media/upload answers 201 with a new asset but 200 with the EXISTING
  // one when the same researcher re-uploads identical bytes (UNIQUE (userid,
  // content_hash)). Prepending blindly would show one asset twice under one key.
  const a = { id: 'a', filename: 'one.png' };
  const b = { id: 'b', filename: 'two.png' };

  it('prepends a genuinely new asset, newest first', () => {
    expect(mergeAsset([a], b)).toEqual([b, a]);
  });

  it('replaces rather than duplicates on a dedupe hit', () => {
    expect(mergeAsset([a, b], a)).toEqual([a, b]);
    expect(mergeAsset([a, b], a)).toHaveLength(2);
  });

  it('takes the server\'s version of the row on a dedupe hit', () => {
    const renamed = { id: 'a', filename: 'original-name.png' };
    expect(mergeAsset([a], renamed)[0].filename).toBe('original-name.png');
  });

  it('handles an empty or missing list', () => {
    expect(mergeAsset([], a)).toEqual([a]);
    expect(mergeAsset(undefined, a)).toEqual([a]);
  });

  it('is a no-op for a missing asset', () => {
    expect(mergeAsset([a], null)).toEqual([a]);
  });
});

describe('formatBytes', () => {
  // Base 1024 with one decimal at MB, matching dashboard-server's validateUpload
  // message ("image is 6.2 MB, maximum is 5.0 MB"). A researcher told to shrink
  // a 6.2 MB file has to be able to find the 6.2 MB row.
  it('agrees with the server\'s MB convention', () => {
    expect(formatBytes(6.2 * 1024 * 1024)).toBe('6.2 MB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('scales through B, KB, MB and GB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('handles byteSize arriving as a string', () => {
    expect(formatBytes('2048')).toBe('2.0 KB');
  });

  it('shows a dash rather than NaN for a missing size', () => {
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(null)).toBe('—');
  });
});

describe('isPreviewable', () => {
  it('previews images only', () => {
    expect(isPreviewable({ mediaType: 'image' })).toBe(true);
    expect(isPreviewable({ mediaType: 'video' })).toBe(false);
    expect(isPreviewable({ mediaType: 'file' })).toBe(false);
    expect(isPreviewable(null)).toBe(false);
  });
});

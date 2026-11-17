import {
  isMetaOrigin, loginOptions, parseSignupMessage, describeRegistration,
} from './embeddedSignup';

describe('isMetaOrigin', () => {
  it('accepts facebook.com and its subdomains over https', () => {
    expect(isMetaOrigin('https://www.facebook.com')).toBe(true);
    expect(isMetaOrigin('https://web.facebook.com')).toBe(true);
    expect(isMetaOrigin('https://facebook.com')).toBe(true);
  });

  it('rejects lookalike hosts, plain http and garbage', () => {
    expect(isMetaOrigin('https://evilfacebook.com')).toBe(false);
    expect(isMetaOrigin('https://facebook.com.evil.io')).toBe(false);
    expect(isMetaOrigin('http://www.facebook.com')).toBe(false);
    expect(isMetaOrigin('null')).toBe(false);
    expect(isMetaOrigin(undefined)).toBe(false);
  });
});

describe('loginOptions', () => {
  it('requests a code with the v4 setup extras', () => {
    expect(loginOptions('cfg1')).toEqual({
      config_id: 'cfg1',
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {} },
    });
  });
});

describe('parseSignupMessage', () => {
  const finish = {
    type: 'WA_EMBEDDED_SIGNUP',
    event: 'FINISH',
    data: { phone_number_id: '111', waba_id: '222', business_id: '333' },
  };

  it('reads ids nested under data on FINISH', () => {
    expect(parseSignupMessage(finish)).toEqual({ kind: 'finish', phoneNumberId: '111', wabaId: '222' });
  });

  it('parses the JSON string form Meta posts', () => {
    expect(parseSignupMessage(JSON.stringify(finish))).toEqual(
      { kind: 'finish', phoneNumberId: '111', wabaId: '222' },
    );
  });

  it('ignores ids at the top level, which Meta does not send', () => {
    const flat = {
      type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', phone_number_id: '111', waba_id: '222',
    };
    expect(parseSignupMessage(flat).kind).toBe('error');
  });

  it('treats a FINISH variant without a phone number as an error', () => {
    const onlyWaba = { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_ONLY_WABA', data: { waba_id: '222' } };
    expect(parseSignupMessage(onlyWaba).kind).toBe('error');
  });

  it('reports CANCEL with the step the user left on', () => {
    const cancel = { type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: { current_step: 'PHONE_NUMBER_SETUP' } };
    expect(parseSignupMessage(cancel)).toEqual({ kind: 'cancel', step: 'PHONE_NUMBER_SETUP' });
  });

  it('reports ERROR with Meta\'s message and code', () => {
    const error = {
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'ERROR',
      data: { error_message: 'Number already in use', error_code: 524126, session_id: 's1' },
    };
    expect(parseSignupMessage(error)).toEqual({
      kind: 'error', message: 'Number already in use', code: '524126', sessionId: 's1',
    });
  });

  it('ignores unrelated messages', () => {
    expect(parseSignupMessage('not json')).toBeNull();
    expect(parseSignupMessage({ type: 'SOMETHING_ELSE' })).toBeNull();
    expect(parseSignupMessage(null)).toBeNull();
    expect(parseSignupMessage({ type: 'WA_EMBEDDED_SIGNUP', event: 'STEP' })).toBeNull();
  });
});

describe('describeRegistration', () => {
  it('is ok when the number was registered now or before', () => {
    expect(describeRegistration(200, { registration: 'registered' })).toEqual({ ok: true });
    expect(describeRegistration(200, { registration: 'already_registered' })).toEqual({ ok: true });
  });

  it('surfaces Meta\'s registration error', () => {
    const r = describeRegistration(502, { registration: 'failed', registration_error: { message: 'PIN mismatch' } });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('PIN mismatch');
  });

  it('handles a plain string error and an empty body', () => {
    expect(describeRegistration(404, { error: 'No WhatsApp number' }).message).toContain('No WhatsApp number');
    expect(describeRegistration(500, null).ok).toBe(false);
  });
});

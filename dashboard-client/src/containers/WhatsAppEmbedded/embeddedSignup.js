// Meta's WhatsApp Embedded Signup (v4) protocol, kept free of the DOM and the
// network so the component only wires these decisions to IO.

// Only facebook.com and its subdomains, over HTTPS. A bare suffix check would
// also admit a host like "evilfacebook.com".
export function isMetaOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch (e) {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com');
}

export function loginOptions(configId) {
  return {
    config_id: configId,
    response_type: 'code',
    override_default_response_type: true,
    extras: { setup: {} },
  };
}

/**
 * Classifies a postMessage payload from the signup popup.
 *
 * @returns {null
 *   | { kind: 'finish', phoneNumberId: string, wabaId: string }
 *   | { kind: 'cancel', step: string | null }
 *   | { kind: 'error', message: string, code: string | null, sessionId: string | null }}
 *   null for anything that is not a WA_EMBEDDED_SIGNUP session event.
 */
export function parseSignupMessage(raw) {
  let msg = raw;
  if (typeof msg === 'string') {
    try {
      msg = JSON.parse(msg);
    } catch (e) {
      return null;
    }
  }
  if (!msg || typeof msg !== 'object' || msg.type !== 'WA_EMBEDDED_SIGNUP') return null;

  const data = msg.data || {};
  const event = typeof msg.event === 'string' ? msg.event : '';

  if (event === 'CANCEL') {
    return { kind: 'cancel', step: data.current_step || null };
  }
  if (event === 'ERROR') {
    return {
      kind: 'error',
      message: data.error_message || 'WhatsApp signup reported an error',
      code: data.error_code != null ? String(data.error_code) : null,
      sessionId: data.session_id || null,
    };
  }
  if (event.startsWith('FINISH')) {
    // FINISH_ONLY_WABA and similar variants can end without a phone number,
    // and Fly cannot run surveys without one.
    if (!data.phone_number_id || !data.waba_id) {
      return {
        kind: 'error',
        message: 'Signup finished without a phone number. Run it again and add or select a phone number.',
        code: null,
        sessionId: null,
      };
    }
    return { kind: 'finish', phoneNumberId: String(data.phone_number_id), wabaId: String(data.waba_id) };
  }
  return null;
}

// What to tell the researcher after POST /whatsapp/register answered.
export function describeRegistration(status, body) {
  const b = body || {};
  if (status === 200 && (b.registration === 'registered' || b.registration === 'already_registered')) {
    return { ok: true };
  }
  const err = b.registration_error || b.error || {};
  const detail = typeof err === 'string' ? err : err.message;
  return {
    ok: false,
    message: `Your account is connected, but WhatsApp did not register the phone number${
      detail ? `: ${detail}` : '.'
    } Messages cannot be sent from it until it is registered.`,
  };
}

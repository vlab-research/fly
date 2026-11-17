import React, { useEffect, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { Spin, message } from 'antd';
import api from '../../services/api';
import WhatsAppWarning from './WhatsAppWarning';
import {
  isMetaOrigin, loginOptions, parseSignupMessage, describeRegistration,
} from './embeddedSignup';

const initFB = (cb) => {
  const appId = process.env.REACT_APP_FACEBOOK_APP_ID;
  const version = process.env.REACT_APP_FACEBOOK_GRAPH_VERSION;

  if (window.FB) {
    cb();
    return;
  }

  window.fbAsyncInit = () => {
    window.FB.init({
      version: `v${version}`,
      appId,
      xfbml: true,
    });

    cb();
  };
};

const loadSDK = () => {
  function load(d, s, id) {
    const fjs = d.getElementsByTagName(s)[0];
    if (d.getElementById(id)) return;
    const js = d.createElement(s);
    js.id = id;
    js.src = 'https://connect.facebook.net/en_US/sdk.js';
    fjs.parentNode.insertBefore(js, fjs);
  }

  load(document, 'script', 'facebook-jssdk');
};

const readJSON = async (res) => {
  try {
    return await res.json();
  } catch (e) {
    return null;
  }
};

const errorText = (body, fallback) => {
  const err = body && body.error;
  if (!err) return fallback;
  return typeof err === 'string' ? err : err.message || JSON.stringify(err);
};

const WhatsAppEmbedded = () => {
  const history = useHistory();
  // 'loading' | 'idle' | 'popup' | 'exchanging' | 'registering' | 'success' | 'cancelled' | 'error'
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [code, setCode] = useState(null);
  const [signup, setSignup] = useState(null);

  const back = () => history.go(-1);

  const fail = (msg) => {
    setError(msg);
    setStatus('error');
  };

  const handleMessage = (event) => {
    if (!isMetaOrigin(event.origin)) return;
    const parsed = parseSignupMessage(event.data);
    if (!parsed) return;

    if (parsed.kind === 'finish') {
      setSignup({ phoneNumberId: parsed.phoneNumberId, wabaId: parsed.wabaId });
    } else if (parsed.kind === 'cancel') {
      setStatus('cancelled');
    } else {
      const ref = [parsed.code && `code ${parsed.code}`, parsed.sessionId && `session ${parsed.sessionId}`]
        .filter(Boolean).join(', ');
      fail(ref ? `${parsed.message} (${ref})` : parsed.message);
    }
  };

  // Opened from a click: browsers block popups that no user gesture started.
  const initiateFlow = () => {
    const configId = process.env.REACT_APP_WHATSAPP_CONFIG_ID;
    if (!configId) {
      fail('WhatsApp config ID not configured');
      return;
    }

    setError(null);
    setCode(null);
    setSignup(null);
    setStatus('popup');

    window.FB.login((res) => {
      if (res.authResponse && res.authResponse.code) {
        setCode(res.authResponse.code);
        return;
      }
      // Closing the popup early returns no code; a CANCEL or ERROR message,
      // if Meta sent one, has already set the status.
      setStatus(s => (s === 'popup' ? 'cancelled' : s));
    }, loginOptions(configId));
  };

  const connect = async (authCode, { phoneNumberId, wabaId }) => {
    setStatus('exchanging');
    try {
      const exchangeRes = await api.fetcher({
        path: '/whatsapp/exchange-code',
        method: 'POST',
        body: { code: authCode, phone_number_id: phoneNumberId, waba_id: wabaId },
        raw: true,
      });
      const exchanged = await readJSON(exchangeRes);
      if (!exchangeRes.ok) {
        fail(errorText(exchanged, 'Could not exchange the signup code with WhatsApp'));
        return;
      }

      const credRes = await api.fetcher({
        path: '/credentials',
        method: 'POST',
        body: {
          entity: 'whatsapp_business',
          key: phoneNumberId,
          details: { id: phoneNumberId, waba_id: wabaId, access_token: exchanged.access_token },
        },
        raw: true,
      });
      if (!credRes.ok) {
        fail(errorText(await readJSON(credRes), 'Could not save the WhatsApp credentials'));
        return;
      }

      setStatus('registering');
      const regRes = await api.fetcher({
        path: '/whatsapp/register',
        method: 'POST',
        body: { phone_number_id: phoneNumberId },
        raw: true,
      });
      const registration = describeRegistration(regRes.status, await readJSON(regRes));
      if (!registration.ok) {
        fail(registration.message);
        return;
      }

      setStatus('success');
      message.success('WhatsApp Business Account connected successfully');
      setTimeout(() => back(), 1500);
    } catch (e) {
      console.error(e); // eslint-disable-line no-console
      fail(e.message || 'An unexpected error occurred');
    }
  };

  // The code (from the login callback) and the ids (from the session message)
  // arrive separately and in either order. The code expires after 30 seconds,
  // so connect as soon as both are here.
  useEffect(() => {
    if (code && signup) connect(code, signup);
  }, [code, signup]);

  useEffect(() => {
    loadSDK();
    window.addEventListener('message', handleMessage);
    initFB(() => setStatus('idle'));
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const button = (label, onClick) => (
    <button type="button" onClick={onClick} style={{ padding: '10px 20px', fontSize: 16, marginRight: 8 }}>
      {label}
    </button>
  );

  return (
    <div style={{ width: 600, margin: '2em auto' }}>
      <h1>WhatsApp Business Account Connection</h1>
      <WhatsAppWarning />

      {status === 'loading' && <Spin tip="Initializing..." />}

      {status === 'idle' && (
        <div>
          <p>Click &quot;Continue&quot; to connect your WhatsApp Business Account.</p>
          {button('Continue', initiateFlow)}
        </div>
      )}

      {status === 'popup' && <Spin tip="Complete the steps in the WhatsApp window..." />}

      {status === 'exchanging' && <Spin tip="Connecting to WhatsApp..." />}

      {status === 'registering' && <Spin tip="Registering your phone number..." />}

      {status === 'success' && <div>Success! Redirecting...</div>}

      {status === 'cancelled' && (
        <div style={{ marginTop: '20px' }}>
          <p>The WhatsApp signup was closed before it finished. Nothing was connected.</p>
          {button('Try again', initiateFlow)}
          {button('Go Back', back)}
        </div>
      )}

      {status === 'error' && (
        <div style={{ color: 'red', marginTop: '20px' }}>
          <p>
Error:
            {error}
          </p>
          {button('Try again', initiateFlow)}
          {button('Go Back', back)}
        </div>
      )}
    </div>
  );
};

export default WhatsAppEmbedded;

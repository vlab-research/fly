import React, { useEffect, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { Spin, message } from 'antd';
import api from '../../services/api';
import WhatsAppWarning from './WhatsAppWarning';

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

const WhatsAppEmbedded = () => {
  const history = useHistory();
  const [status, setStatus] = useState('loading'); // 'loading', 'idle', 'exchanging', 'success', 'error'
  const [error, setError] = useState(null);
  const [code, setCode] = useState(null);
  const [phoneNumberId, setPhoneNumberId] = useState(null);

  const back = () => history.go(-1);

  // Handle postMessage from Facebook Embedded Signup popup
  const handleMessage = (event) => {
    // Security: validate origin
    if (!event.origin.endsWith('facebook.com')) {
      return;
    }

    let data = event.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (e) {
        return;
      }
    }

    if (data && data.type === 'WA_EMBEDDED_SIGNUP') {
      if (data.phone_number_id && data.waba_id) {
        setPhoneNumberId({ phoneId: data.phone_number_id, wabaId: data.waba_id });
      }
    }
  };

  // Initiate FB.login and exchange flow
  const initiateFlow = () => {
    const configId = process.env.REACT_APP_WHATSAPP_CONFIG_ID;

    if (!configId) {
      setError('WhatsApp config ID not configured');
      setStatus('error');
      return;
    }

    const config = {
      config_id: configId,
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        sessionInfoVersion: '3',
      },
    };

    window.FB.login((res) => {
      if (res.error) {
        setError(JSON.stringify(res.error));
        setStatus('error');
        return;
      }

      if (!res.authResponse || !res.authResponse.code) {
        setError('No authorization code in response');
        setStatus('error');
        return;
      }

      setCode(res.authResponse.code);
    }, config);
  };

  // Exchange code for access token once both code and phoneNumberId are available
  const exchangeCodeForToken = async (authCode, phoneId) => {
    setStatus('exchanging');
    try {
      const exchangeRes = await api.fetcher({
        path: '/whatsapp/exchange-code',
        method: 'POST',
        body: {
          code: authCode,
          phone_number_id: phoneId.phoneId,
          waba_id: phoneId.wabaId,
        },
      });

      if (!exchangeRes.ok) {
        const errData = await exchangeRes.json();
        setError(JSON.stringify(errData.error || 'Failed to exchange code'));
        setStatus('error');
        return;
      }

      const { access_token, phone_number_id } = await exchangeRes.json();

      // Now save credentials to backend
      const credBody = {
        entity: 'whatsapp_business',
        key: phone_number_id,
        details: {
          id: phone_number_id,
          waba_id: phoneId.wabaId,
          access_token,
        },
      };

      const credRes = await api.fetcher({
        path: '/credentials',
        method: 'POST',
        body: credBody,
        raw: true,
      });

      if (!credRes.ok) {
        const errData = await credRes.json();
        setError(JSON.stringify(errData.error || 'Failed to save credentials'));
        setStatus('error');
        return;
      }

      setStatus('success');
      message.success('WhatsApp Business Account connected successfully');
      setTimeout(() => back(), 1500);
    } catch (e) {
      console.error(e); // eslint-disable-line no-console
      setError(e.message || 'An unexpected error occurred');
      setStatus('error');
    }
  };

  // Trigger exchange when both pieces are ready
  useEffect(() => {
    if (code && phoneNumberId) {
      exchangeCodeForToken(code, phoneNumberId);
    }
  }, [code, phoneNumberId]);

  // Initialize FB SDK and start flow
  useEffect(() => {
    loadSDK();
    window.addEventListener('message', handleMessage);

    initFB(() => {
      setStatus('idle');
      initiateFlow();
    });

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  return (
    <div style={{ width: 600, margin: '2em auto' }}>
      <h1>WhatsApp Business Account Connection</h1>
      <WhatsAppWarning />

      {status === 'loading' && <Spin tip="Initializing..." />}

      {status === 'idle' && (
        <div>
          <p>Click "Continue" to connect your WhatsApp Business Account.</p>
          <button onClick={initiateFlow} style={{ padding: '10px 20px', fontSize: 16 }}>
            Continue
          </button>
        </div>
      )}

      {status === 'exchanging' && <Spin tip="Connecting to WhatsApp..." />}

      {status === 'success' && <div>Success! Redirecting...</div>}

      {status === 'error' && (
        <div style={{ color: 'red', marginTop: '20px' }}>
          <p>Error: {error}</p>
          <button onClick={back} style={{ padding: '10px 20px', fontSize: 16 }}>
            Go Back
          </button>
        </div>
      )}
    </div>
  );
};

export default WhatsAppEmbedded;

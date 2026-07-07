/* eslint-disable no-console */
import auth0 from 'auth0-js';
import history from '../history';

import AUTH_CONFIG from './auth0-variables';

class Auth {
  constructor() {
    this.listeners = [];

    this.auth0 = new auth0.WebAuth({
      domain: AUTH_CONFIG.domain,
      clientID: AUTH_CONFIG.clientId,
      redirectUri: AUTH_CONFIG.callbackUrl,
      responseType: 'token id_token',
      scope: 'openid email',
    });

    console.log('[AUTH] Constructor', {
      domain: AUTH_CONFIG.domain,
      clientId: AUTH_CONFIG.clientId,
      callbackUrl: AUTH_CONFIG.callbackUrl,
      isLoggedIn: localStorage.getItem('isLoggedIn'),
      hasStoredSession: sessionStorage.getItem('authSession') !== null,
      hasReturnTo: sessionStorage.getItem('authReturnTo'),
      location: window.location.href,
    });

    const stored = sessionStorage.getItem('authSession');
    if (stored) {
      try {
        const session = JSON.parse(stored);
        if (new Date().getTime() < session.expiresAt) {
          this.accessToken = session.accessToken;
          this.idToken = session.idToken;
          this.expiresAt = session.expiresAt;
          this.userEmail = session.userEmail;
          localStorage.setItem('isLoggedIn', 'true');
          console.log('[AUTH] Restored session from sessionStorage');
        } else {
          sessionStorage.removeItem('authSession');
          localStorage.removeItem('isLoggedIn');
          console.log('[AUTH] Stored session expired, cleared');
        }
      } catch (e) {
        sessionStorage.removeItem('authSession');
        localStorage.removeItem('isLoggedIn');
      }
    }

    const loggedIn = localStorage.getItem('isLoggedIn');
    if (loggedIn && !this.accessToken) {
      this.renewSession();
    }
  }

  subscribe = (fn) => {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  };

  notify = () => {
    this.listeners.forEach(fn => fn());
  };

  login = () => {
    this.auth0.authorize();
  };

  handleAuthentication = () => {
    console.log('[AUTH] handleAuthentication', { hash: window.location.hash });
    this.auth0.parseHash((err, authResult) => {
      if (authResult && authResult.accessToken && authResult.idToken) {
        const returnTo = sessionStorage.getItem('authReturnTo');
        sessionStorage.removeItem('authReturnTo');
        console.log('[AUTH] parseHash success', { returnTo });
        this.setSession(authResult, returnTo || '/');
      } else if (err) {
        console.error('[AUTH] parseHash error', err);
        history.push('/login');
      }
    });
  };

  getAccessToken = () => this.accessToken;

  getIdToken = () => this.idToken;

  getUserEmail = () => this.userEmail;

  setSession = ({
    expiresIn, accessToken, idToken, idTokenPayload,
  }, forward) => {
    this.userEmail = idTokenPayload.email;

    localStorage.setItem('isLoggedIn', 'true');

    const expiresAt = expiresIn * 3600 + new Date().getTime();
    this.accessToken = accessToken;
    this.idToken = idToken;
    this.expiresAt = expiresAt;

    sessionStorage.setItem('authSession', JSON.stringify({
      accessToken, idToken, expiresAt, userEmail: this.userEmail,
    }));

    console.log('[AUTH] setSession', { expiresIn, expiresAt, forward });
    this.notify();

    if (forward) {
      return history.replace(forward);
    }
    return history.replace(history.location);
  };

  renewSession = () => {
    this.renewing = true;
    console.log('[AUTH] renewSession: calling checkSession');
    this.auth0.checkSession({}, (err, authResult) => {
      if (authResult && authResult.accessToken && authResult.idToken) {
        console.log('[AUTH] checkSession success');
        this.setSession(authResult);
        this.renewing = false;
      } else if (err) {
        const { pathname, search, hash } = window.location;
        const returnUrl = pathname + search + hash;
        console.error('[AUTH] checkSession error', err, { returnUrl });
        if (returnUrl !== '/login') {
          sessionStorage.setItem('authReturnTo', returnUrl);
        }
        this.clear();
        this.renewing = false;
        this.notify();
        history.push('/login');
      }
    });
  };

  clear = () => {
    this.accessToken = null;
    this.idToken = null;
    this.expiresAt = 0;
    this.userEmail = null;
    localStorage.removeItem('isLoggedIn');
    sessionStorage.removeItem('authSession');
  }

  logout = () => {
    sessionStorage.removeItem('authSession');
    this.clear();
    this.notify();
    const returnTo = '';
    this.auth0.logout({ clientID: this.auth0.clientID, returnTo });
  };

  // Check whether the current time is past the
  // access token's expiry time
  isAuthenticated = () => new Date().getTime() < this.expiresAt;
}

export default new Auth();

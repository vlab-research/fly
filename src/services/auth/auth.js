/* eslint-disable no-console */
import auth0 from 'auth0-js';

import AUTH_CONFIG from './auth0-variables';

export default class Auth {
  constructor() {
    const auth = localStorage.getItem('auth');
    if (auth) {
      const { accessToken, idToken, expiresAt } = JSON.parse(localStorage.getItem('auth'));
      this.accessToken = accessToken;
      this.idToken = idToken;
      this.expiresAt = expiresAt;
    }

    this.auth0 = new auth0.WebAuth({
      domain: AUTH_CONFIG.domain,
      clientID: AUTH_CONFIG.clientId,
      redirectUri: AUTH_CONFIG.callbackUrl,
      responseType: 'token id_token',
      scope: 'openid email',
    });
  }

  login = () => {
    this.auth0.authorize();
  };

  handleAuthentication = history => {
    this.auth0.parseHash((err, authResult) => {
      if (authResult && authResult.accessToken && authResult.idToken) {
        this.setSession(authResult, history);
      } else if (err) {
        console.error(err);
      }
    });
  };

  getAccessToken = () => this.accessToken;

  getIdToken = () => this.idToken;

  setSession = ({ expiresIn, accessToken, idToken }, history) => {
    // Set isLoggedIn flag in localStorage
    localStorage.setItem('isLoggedIn', 'true');

    // Set the time that the access token will expire at
    const expiresAt = expiresIn * 3600 + new Date().getTime();
    this.accessToken = accessToken;
    this.idToken = idToken;
    this.expiresAt = expiresAt;
    const auth = {
      accessToken,
      idToken,
      expiresAt,
    };

    localStorage.setItem('auth', JSON.stringify(auth));
    history.push('/');
  };

  renewSession = () => {
    this.auth0.checkSession({}, (err, authResult) => {
      if (authResult && authResult.accessToken && authResult.idToken) {
        this.setSession(authResult);
      } else if (err) {
        this.logout();
        console.error(err);
      }
    });
  };

  logout = () => {
    // Remove tokens and expiry time
    this.accessToken = null;
    this.idToken = null;
    this.expiresAt = 0;

    // Remove isLoggedIn flag from localStorage
    localStorage.removeItem('isLoggedIn');
    localStorage.removeItem('auth');

    // navigate to the home route
  };

  isAuthenticated = () => {
    // Check whether the current time is past the
    // access token's expiry time
    return new Date().getTime() < this.expiresAt;
  };
}
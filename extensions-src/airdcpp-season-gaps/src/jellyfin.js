'use strict';

// A small client for the Jellyfin-compatible HTTP API that the client's own media server serves
// on loopback. Self-contained on purpose: several extensions carry this same file.
//
// Facts it relies on, all from airdcpp/airdcpp/modules/mediaserver/JellyfinApi.cpp at
// origin/master f163a4989:
// - POST /Users/AuthenticateByName {Username, Pw} is an open route (JellyfinApi.cpp:13194,
//   handler authenticate() at :4083) and answers {User, AccessToken, ...} (:4050).
// - The token is read from X-Emby-Token first (requestToken(), :3388), then from Token="..." in
//   Authorization / X-Emby-Authorization (:3400), then from ?api_key= (:3422). The
//   Authorization header without a Token= part still names the device (requestIdentity(), :3342).
// - Failed sign-ins are throttled per address with 429 (:4126, MAX_SIGNIN_FAILURES = 10 at :327),
//   so this client signs in at most once per request and backs off after a refusal.
// - Sessions live in memory (rememberSession(), :882, at most 64 kept, :88) and end after 90 idle
//   days (SESSION_IDLE_SECONDS, JellyfinApi.h:2223) or on a client restart: a 401 on a stored
//   token is normal and is answered by one fresh sign-in.

const LOGIN_BACKOFF_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;

const quote = (value) => String(value || '').replace(/["\\\r\n]/g, '');

const httpError = (status, reason) => {
  const error = new Error(reason);
  error.status = status;
  return error;
};

// Messages from an allow-list only: a fetch error can carry a header value or a URL
const networkError = (error) => {
  const code = error && (error.code || (error.cause && error.cause.code));
  if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return httpError(0, 'the media server did not answer in time');
  }

  if (code === 'ECONNREFUSED') {
    return httpError(0, 'the media server refused the connection (is it running?)');
  }

  return httpError(0, `could not reach the media server${typeof code === 'string' && /^[A-Z_]+$/.test(code) ? ` (${code})` : ''}`);
};

const createJellyfin = ({ getBaseUrl, getCredentials, loadToken, saveToken, fetchImpl, now = () => Date.now() }) => {
  let loginRefusedAt = 0;
  const doFetch = fetchImpl || ((...args) => fetch(...args));

  const authHeader = (creds) => `MediaBrowser Client="${quote(creds.client || 'FulDC++ extension')}", Device="FulDC++ extension", DeviceId="${quote(creds.deviceId)}", Version="${quote(creds.version || '1.0.0')}"`;

  const buildUrl = async (path, query) => {
    const base = String(await getBaseUrl() || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) {
      throw httpError(0, 'the media server address is not known');
    }

    const url = new URL(base + (path.startsWith('/') ? path : `/${path}`));
    for (const [ key, value ] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  };

  const send = async (method, path, { query, body, token, creds }) => {
    const headers = { Accept: 'application/json', Authorization: authHeader(creds) };
    if (token) {
      headers['X-Emby-Token'] = token;
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const options = { method, headers, redirect: 'error' };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      options.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    }

    const url = await buildUrl(path, query);
    let response;
    try {
      response = await doFetch(url, options);
    } catch (error) {
      throw networkError(error);
    }

    return response;
  };

  const readJson = async (response) => {
    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw httpError(response.status, 'the media server sent an answer that is not JSON');
    }
  };

  const login = async (creds) => {
    if (!creds.username) {
      throw httpError(401, 'no media server user name is set');
    }

    if (loginRefusedAt && now() - loginRefusedAt < LOGIN_BACKOFF_MS) {
      throw httpError(401, 'the media server refused the sign-in recently; waiting before trying again');
    }

    const response = await send('POST', '/Users/AuthenticateByName', {
      body: { Username: creds.username, Pw: creds.password || '' },
      creds,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 429) {
        loginRefusedAt = now();
      }

      throw httpError(response.status, response.status === 429 ?
        'the media server is throttling sign-ins (too many failures)' :
        `the media server refused the sign-in (HTTP ${response.status})`);
    }

    const data = await readJson(response);
    const token = data && typeof data.AccessToken === 'string' ? data.AccessToken : '';
    if (!token) {
      throw httpError(response.status, 'the media server sign-in answer had no token');
    }

    loginRefusedAt = 0;
    await saveToken(token);
    return token;
  };

  const request = async (method, path, { query, body } = {}) => {
    const creds = (await getCredentials()) || {};
    const pasted = creds.token ? String(creds.token).trim() : '';
    let token = pasted || (await loadToken()) || '';
    let signedInNow = false;

    if (!token) {
      token = await login(creds);
      signedInNow = true;
    }

    let response = await send(method, path, { query, body, token, creds });
    if (response.status === 401 && !signedInNow) {
      // A stored token the server no longer knows (it restarted, or the session idled out).
      // A pasted token is the user's: it is never thrown away, but a user name lets us sign in.
      if (!pasted) {
        await saveToken(null);
      }

      if (creds.username) {
        token = await login(creds);
        response = await send(method, path, { query, body, token, creds });
      }
    }

    if (!response.ok) {
      throw httpError(response.status, response.status === 401 ?
        'the media server refused the credentials' :
        `the media server answered HTTP ${response.status}`);
    }

    return readJson(response);
  };

  return {
    get: (path, query) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body: body === undefined ? {} : body }),
    del: (path) => request('DELETE', path, {}),
  };
};

module.exports = { createJellyfin };

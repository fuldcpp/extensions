'use strict';

// A small client for the Jellyfin-compatible HTTP API the client serves itself (the extension Web
// API exposes almost nothing of the media server). Self-contained on purpose: several extensions
// carry this same file.
//
// Facts it relies on, from airdcpp/airdcpp/modules/mediaserver/JellyfinApi.cpp (origin/master
// f163a4989):
// - POST /Users/AuthenticateByName {Username, Pw} (route :13194, handler :4083) answers
//   {User, AccessToken} (signInAnswer :4048); 401 for a wrong password, 429 when the sign-in
//   throttle (ten a minute per address) is hit.
// - The token is read from X-Emby-Token / X-MediaBrowser-Token, or from a Token="..." field of
//   Authorization / X-Emby-Authorization (requestToken :3380-3412). Client, Device, DeviceId and
//   Version are read from the same Authorization header (requestIdentity :3339-3352).
// - A base URL is optional: requests without it are still answered (handle :12925-12945), so the
//   plain loopback address always works.
// - GET /Users/Me answers the token's own user (:14182).
//
// Errors carry only an allow-listed reason and .status, never a URL or a header value.

const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const LOGIN_BLOCK_MS = 10 * 60 * 1000; // after a refused sign-in: never hammer the throttle

// Which pasted token a remembered user id belongs to, without storing the token itself
const fingerprint = (token) => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);

const quote = (value) => String(value || '').replace(/["\\\r\n]/g, '');

const createError = (reason, status) => {
  const error = new Error(reason);
  if (status !== undefined) {
    error.status = status;
  }

  return error;
};

const joinUrl = (base, path, query) => {
  const root = String(base || '').replace(/\/+$/, '');
  const rel = String(path || '').startsWith('/') ? path : `/${path}`;
  const params = new URLSearchParams();
  for (const [ key, value ] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') {
      params.append(key, String(value));
    }
  }

  const qs = params.toString();
  return `${root}${rel}${qs ? `?${qs}` : ''}`;
};

// createJellyfin({ getBaseUrl, getCredentials, loadToken, saveToken, fetchImpl })
//   getBaseUrl: async () => 'http://127.0.0.1:8096'
//   getCredentials: () => ({ username, password, token, deviceId, client, version })
//     token: a pasted access token (used as-is, never replaced by a sign-in)
//   loadToken: () => ({ accessToken, userId } | null)   (the stored sign-in)
//   saveToken: ({ accessToken, userId } | null) => void
const createJellyfin = ({ getBaseUrl, getCredentials, loadToken, saveToken, fetchImpl, now = () => Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS }) => {
  let loginBlockedUntil = 0;
  let loginInFlight = null;

  const authHeader = (token) => {
    const creds = getCredentials() || {};
    const parts = [
      `Client="${quote(creds.client || 'airdcpp-extension')}"`,
      'Device="FulDC++ extension"',
      `DeviceId="${quote(creds.deviceId || 'airdcpp-extension')}"`,
      `Version="${quote(creds.version || '1.0.0')}"`,
    ];
    if (token) {
      parts.push(`Token="${quote(token)}"`);
    }

    return `MediaBrowser ${parts.join(', ')}`;
  };

  const rawRequest = async (method, path, { query, body, token } = {}) => {
    const base = await getBaseUrl();
    if (!base) {
      throw createError('the media server address is not known (is the media server running?)');
    }

    const headers = { Accept: 'application/json', Authorization: authHeader(token) };
    if (token) {
      headers['X-Emby-Token'] = token;
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response;
    try {
      response = await fetchImpl(joinUrl(base, path, query), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (error) {
      // The fetch error text may name the address; the reason is all that is reported
      const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw createError(timedOut ? 'the media server did not answer in time' : 'could not connect to the media server');
    }

    if (!response.ok) {
      throw createError(`the media server answered HTTP ${response.status}`, response.status);
    }

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
      throw createError('the media server sent something that is not JSON', response.status);
    }
  };

  const signIn = async () => {
    const creds = getCredentials() || {};
    if (!creds.username) {
      throw createError('no media-server user name or access token is set', 401);
    }

    if (now() < loginBlockedUntil) {
      throw createError('signing in is paused after a refused sign-in', 401);
    }

    let answer;
    try {
      answer = await rawRequest('POST', '/Users/AuthenticateByName', { body: { Username: creds.username, Pw: creds.password || '' } });
    } catch (error) {
      if (error.status === 401 || error.status === 403 || error.status === 429) {
        loginBlockedUntil = now() + LOGIN_BLOCK_MS;
        throw createError(error.status === 429 ? 'the media server is throttling sign-ins' : 'the media server refused the user name or password', error.status);
      }

      throw error;
    }

    const accessToken = answer && typeof answer.AccessToken === 'string' ? answer.AccessToken : '';
    const userId = answer && answer.User && typeof answer.User.Id === 'string' ? answer.User.Id : '';
    if (!accessToken || !userId) {
      throw createError('the sign-in answer had no access token');
    }

    const stored = { accessToken, userId };
    saveToken(stored);
    return stored;
  };

  // One sign-in at a time, however many requests found they needed one
  const signInOnce = () => {
    if (!loginInFlight) {
      loginInFlight = signIn().finally(() => {
        loginInFlight = null;
      });
    }

    return loginInFlight;
  };

  const pastedToken = () => {
    const creds = getCredentials() || {};
    return creds.token ? String(creds.token).trim() : '';
  };

  // { accessToken, userId? }
  const session = async () => {
    const pasted = pastedToken();
    if (pasted) {
      const stored = loadToken();
      return { accessToken: pasted, userId: stored && stored.pasted === fingerprint(pasted) ? stored.userId : '' };
    }

    const stored = loadToken();
    if (stored && stored.accessToken && !stored.pasted) {
      return stored;
    }

    return signInOnce();
  };

  const request = async (method, path, options = {}) => {
    const current = await session();
    try {
      return await rawRequest(method, path, { ...options, token: current.accessToken });
    } catch (error) {
      // A stored sign-in that expired: sign in again, once. A pasted token is the user's to fix.
      if (error.status === 401 && !pastedToken()) {
        saveToken(null);
        const fresh = await signInOnce();
        return rawRequest(method, path, { ...options, token: fresh.accessToken });
      }

      throw error;
    }
  };

  // The signed-in user's id (GET /Users/Me for a pasted token, JellyfinApi.cpp:14182)
  const userId = async () => {
    const current = await session();
    if (current.userId) {
      return current.userId;
    }

    const me = await request('GET', '/Users/Me');
    const id = me && typeof me.Id === 'string' ? me.Id : '';
    if (!id) {
      throw createError('the media server did not say who the access token belongs to');
    }

    if (pastedToken()) {
      saveToken({ accessToken: '', userId: id, pasted: fingerprint(pastedToken()) });
    }

    return id;
  };

  return {
    get: (path, query) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body }),
    del: (path) => request('DELETE', path, {}),
    userId,
  };
};

module.exports = { createJellyfin, joinUrl };

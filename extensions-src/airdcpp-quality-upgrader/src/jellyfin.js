'use strict';

// A small client for the Jellyfin-compatible HTTP API of the client's own media server, over
// loopback. Self-contained (no other module of this extension) so several extensions can carry
// the same file.
//
// Verified against airdcpp-windows origin/master (f163a4989),
// airdcpp/airdcpp/modules/mediaserver/JellyfinApi.cpp:
// - POST /Users/AuthenticateByName {Username, Pw}: route at :13194, body read at :4083-4088,
//   answer carries AccessToken and User (:4050). 401 on a wrong password, 429 when throttled.
// - The token is read from X-Emby-Token / X-MediaBrowser-Token or from Token="..." inside
//   Authorization / X-Emby-Authorization (requestToken, :3388 onwards). We send it inside the
//   Authorization header together with the device fields.
// - GET /Users/Me answers the signed-in user (:14182), used when a token was pasted.
//
// createJellyfin({ getBaseUrl, getCredentials, loadToken, saveToken, fetchImpl, device })
//   getBaseUrl(): Promise<string|null>  e.g. "http://127.0.0.1:8096" (no trailing slash)
//   getCredentials(): { username, password, token }  token = a pasted access token (optional)
//   loadToken(): { accessToken, userId } | null      saveToken(value | null)
//   device: { client, deviceId, version }
// -> { get(path, query), post(path, body), del(path), userId() }
// Every failure throws an Error with .status (0 = could not connect) and a message that never
// contains a header, a token or a password.

const TIMEOUT_MS = 20000;

const quote = (value) => String(value || '').replace(/["\\\r\n]/g, '');

const httpError = (status, reason) => Object.assign(new Error(`media server: ${reason}`), { status });

const createJellyfin = ({ getBaseUrl, getCredentials, loadToken, saveToken, fetchImpl = (...a) => fetch(...a), device = {} }) => {
  let session = null; // { accessToken, userId }
  let loginPromise = null;

  const authorization = (token) => {
    let value = `MediaBrowser Client="${quote(device.client || 'FulDC++ extension')}", Device="FulDC++ extension", DeviceId="${quote(device.deviceId || 'fuldc-extension')}", Version="${quote(device.version || '1.0.0')}"`;
    if (token) {
      value += `, Token="${quote(token)}"`;
    }

    return value;
  };

  const baseUrl = async () => {
    const base = await getBaseUrl();
    if (!base || !/^http:\/\//i.test(base)) {
      throw httpError(0, 'not running');
    }

    return base.replace(/\/+$/, '');
  };

  const raw = async (method, path, { query, body, token } = {}) => {
    const url = new URL((await baseUrl()) + path);
    for (const [ key, value ] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers = { Accept: 'application/json', Authorization: authorization(token) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
      });
    } catch (error) {
      // Only the code: a fetch error can quote the request
      const code = (error && error.cause && error.cause.code) || (error && error.name === 'TimeoutError' ? 'timeout' : 'connection failed');
      throw httpError(0, String(code).replace(/[^A-Za-z_ -]/g, ''));
    }

    if (response.status === 204) {
      return null;
    }

    if (!response.ok) {
      throw httpError(response.status, `HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw httpError(response.status, 'the answer is not JSON');
    }
  };

  const login = async () => {
    const credentials = (await getCredentials()) || {};
    if (credentials.token) {
      const me = await raw('GET', '/Users/Me', { token: credentials.token });
      if (!me || !me.Id) throw httpError(500, 'no user id for the token');
      return { accessToken: credentials.token, userId: me.Id };
    }

    if (!credentials.username) {
      throw httpError(401, 'no media server login is configured');
    }

    const answer = await raw('POST', '/Users/AuthenticateByName', { body: { Username: credentials.username, Pw: credentials.password || '' } });
    if (!answer || !answer.AccessToken || !answer.User || !answer.User.Id) {
      throw httpError(500, 'the sign-in answer has no token');
    }

    return { accessToken: answer.AccessToken, userId: answer.User.Id };
  };

  const ensureSession = async (fresh) => {
    if (!fresh) {
      if (session) return session;
      const stored = await loadToken();
      if (stored && stored.accessToken && stored.userId) {
        session = stored;
        return session;
      }
    }

    // One sign-in at a time, however many requests are waiting
    if (!loginPromise) {
      loginPromise = (async () => {
        try {
          session = await login();
          await saveToken(session);
          return session;
        } catch (error) {
          session = null;
          throw error;
        } finally {
          loginPromise = null;
        }
      })();
    }

    return loginPromise;
  };

  const call = async (method, path, options = {}) => {
    const current = await ensureSession(false);
    try {
      return await raw(method, path, { ...options, token: current.accessToken });
    } catch (error) {
      if (error.status !== 401) throw error;
    }

    // The token was revoked or the server forgot it: sign in again, once
    session = null;
    await saveToken(null);
    const renewed = await ensureSession(true);
    return raw(method, path, { ...options, token: renewed.accessToken });
  };

  return {
    get: (path, query) => call('GET', path, { query }),
    post: (path, body) => call('POST', path, { body: body === undefined ? {} : body }),
    del: (path) => call('DELETE', path),
    userId: async () => (await ensureSession(false)).userId,
    forget: () => {
      session = null;
    },
  };
};

// The media server's own address, from the extension Web API's GET media_server
// ({ enabled, running, address, port }; airdcpp-webapi/api/MediaServerApi.cpp:85-95 on
// origin/master). A wildcard bind address is reached over loopback.
const baseUrlFromStatus = (status) => {
  if (!status || !status.running) return null;
  let address = String(status.address || '');
  if (!address) {
    address = status.port ? `http://127.0.0.1:${status.port}` : '';
  }

  const m = /^http:\/\/(\[[^\]]*\]|[^/:]+)(?::(\d+))?\/?$/i.exec(address);
  if (!m) return null;
  let host = m[1];
  if (host === '0.0.0.0' || host === '[::]' || host === '::' || host === '' || host === '*') host = '127.0.0.1';
  const port = m[2] || status.port;
  return `http://${host}${port ? `:${port}` : ''}`;
};

module.exports = { createJellyfin, baseUrlFromStatus };

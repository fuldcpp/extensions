'use strict';

// A small client for the Jellyfin-compatible API that the client's own media server serves on
// loopback. Self-contained on purpose: several FulDC++ extensions carry this same file.
//
// Verified against airdcpp-windows origin/master (f163a4989), JellyfinApi.cpp:
// - POST /Users/AuthenticateByName {Username, Pw} -> {User, AccessToken} (13194, body read at
//   4087, answer built at 4049-4050). Failed sign-ins are throttled per address: 10 a minute
//   (MAX_SIGNIN_FAILURES, 327), so a refused password is NOT retried here.
// - The token is read from X-Emby-Token or from Token="..." in an Authorization: MediaBrowser
//   header (requestToken, 3380). Both are sent.
// - Sessions are capped at 64 and the oldest are evicted (MAX_SESSIONS); the token is therefore
//   stored and reused rather than signing in on every request.

const createJellyfin = ({ getBaseUrl, getCredentials, loadToken, saveToken, fetchImpl, client = 'airdcpp-extension', version = '1.0.0', timeoutMs = 60000 }) => {
  const doFetch = fetchImpl || ((...args) => fetch(...args));

  const fail = (status, message) => {
    const error = new Error(message);
    error.status = status;
    return error;
  };

  const authHeader = (deviceId, token) => {
    // The values are ours, never user text; quotes would end a field early
    const clean = (v) => String(v || '').replace(/["\r\n,]/g, '');
    let value = `MediaBrowser Client="${clean(client)}", Device="FulDC++ extension", DeviceId="${clean(deviceId)}", Version="${clean(version)}"`;
    if (token) {
      value += `, Token="${clean(token)}"`;
    }

    return value;
  };

  const buildUrl = (path, query) => {
    const base = String(getBaseUrl() || '').replace(/\/+$/, '');
    if (!base) {
      throw fail(0, 'The media server address is not known');
    }

    const params = new URLSearchParams();
    for (const [ key, value ] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') {
        params.append(key, String(value));
      }
    }

    const qs = params.toString();
    return `${base}${path.startsWith('/') ? path : `/${path}`}${qs ? `?${qs}` : ''}`;
  };

  // One request. Errors carry only the status and a fixed reason: a fetch error can quote
  // header values, and the token is a header value.
  const raw = async (method, path, { query, body, token, deviceId }) => {
    const headers = { Accept: 'application/json', Authorization: authHeader(deviceId, token) };
    if (token) {
      headers['X-Emby-Token'] = token;
    }

    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let response;
    try {
      response = await doFetch(buildUrl(path, query), {
        method, headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error && error.status !== undefined) throw error;
      const reason = error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timed out' : 'could not connect';
      throw fail(0, `Media server ${reason}`);
    }

    if (!response.ok) {
      throw fail(response.status, `Media server answered ${response.status} for ${method} ${path.split('?')[0]}`);
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
    } catch (e) {
      throw fail(response.status, `Media server sent something that is not JSON for ${path.split('?')[0]}`);
    }
  };

  let signingIn = null;
  let refusedFor = null; // the credentials a sign-in was refused for: not tried again until they change

  const signIn = async () => {
    const { username, password, token: pasted, deviceId } = getCredentials();
    if (!password && pasted) {
      // A pasted token is used as it is; it cannot be renewed here
      return pasted;
    }

    if (!username || !password) {
      throw fail(401, 'No media server user name and password are set');
    }

    const key = `${username}\u0000${password}`;
    if (refusedFor === key) {
      throw fail(401, 'The media server refused this user name and password (change them to try again)');
    }

    try {
      const answer = await raw('POST', '/Users/AuthenticateByName', { body: { Username: username, Pw: password }, deviceId });
      const token = answer && typeof answer.AccessToken === 'string' ? answer.AccessToken : '';
      if (!token) {
        throw fail(0, 'The media server sign-in answered without a token');
      }

      refusedFor = null;
      saveToken(token);
      return token;
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        refusedFor = key;
      }

      throw error;
    }
  };

  const freshToken = () => {
    if (!signingIn) {
      signingIn = signIn().finally(() => { signingIn = null; });
    }

    return signingIn;
  };

  const request = async (method, path, query, body) => {
    const { deviceId, password, token: pasted } = getCredentials();
    let token = loadToken() || (!password && pasted) || '';
    if (!token) {
      token = await freshToken();
    }

    try {
      return await raw(method, path, { query, body, token, deviceId });
    } catch (error) {
      if (error.status !== 401) {
        throw error;
      }

      // Once: a token that is refused again right after a fresh sign-in is not retried
      saveToken('');
      const renewed = await freshToken();
      if (renewed === token) {
        throw error;
      }

      return raw(method, path, { query, body, token: renewed, deviceId });
    }
  };

  return {
    get: (path, query) => request('GET', path, query),
    post: (path, body) => request('POST', path, undefined, body === undefined ? {} : body),
    del: (path) => request('DELETE', path),
  };
};

module.exports = { createJellyfin };

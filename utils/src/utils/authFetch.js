// src/utils/authFetch.js
// Keeps every website request to the backend logged in, automatically.
//
//  * Each request to the backend carries the CURRENT login token, even if the
//    component that made it was started before the user logged in or before the
//    token was renewed (this is what caused "Authorization header required").
//  * Login tokens last 15 minutes. When the backend answers 401, the site asks
//    for a new token with the saved refresh token, then repeats the request once.
//  * If that fails, the user is signed out and sent to the login page, instead of
//    being left on a dashboard with no data.
//  * A new token is also requested in the background every 10 minutes while the
//    page is open, so the live data connection can reconnect with a valid token.
import { API_BASE_URL } from '../config';

const API_PREFIX = `${API_BASE_URL}/api/`;
const REFRESH_EVERY_MS = 10 * 60 * 1000;

let originalFetch = null;
let inFlight = null;

const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
const del = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

async function doRefresh() {
  const rtAtStart = get('refreshToken');
  if (!rtAtStart) return false;

  const run = async () => {
    // Another browser tab may have just renewed the tokens (old refresh tokens
    // stop working once used), so use theirs instead of asking again.
    const rt = get('refreshToken');
    if (!rt) return false;
    if (rt !== rtAtStart) return true;
    try {
      const res = await originalFetch(`${API_BASE_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data.accessToken) return false;
      set('accessToken', data.accessToken);
      if (data.refreshToken) set('refreshToken', data.refreshToken);
      set('tokenRefreshedAt', String(Date.now()));
      window.dispatchEvent(new Event('auth:token-refreshed'));
      return true;
    } catch {
      return false;
    }
  };

  if (navigator.locks && navigator.locks.request) {
    return navigator.locks.request('auth-refresh', run);
  }
  return run();
}

function refreshTokens() {
  if (inFlight) return inFlight;
  const p = doRefresh();
  inFlight = p;
  p.finally(() => { if (inFlight === p) inFlight = null; });
  return p;
}

function signOutAndReload() {
  del('accessToken');
  del('refreshToken');
  window.dispatchEvent(new Event('auth:expired'));
  // Reload once so the login page shows. The guard stops any reload loop.
  try {
    const last = Number(sessionStorage.getItem('auth-expired-reload')) || 0;
    if (Date.now() - last < 30000) return;
    sessionStorage.setItem('auth-expired-reload', String(Date.now()));
  } catch { /* ignore */ }
  window.location.reload();
}

export function installAuthFetch() {
  if (typeof window === 'undefined' || window.__authFetchInstalled) return;
  window.__authFetchInstalled = true;
  originalFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : '');
    const isApi = url.startsWith(API_PREFIX);
    const isAuthCall = /\/api\/auth\/(login|refresh)(\?|$)/.test(url);
    if (!isApi || isAuthCall) return originalFetch(input, init);

    const send = (token) => {
      const headers = new Headers(init.headers || {});
      if (token) headers.set('Authorization', `Bearer ${token}`);
      return originalFetch(input, { ...init, headers });
    };

    const res = await send(get('accessToken'));
    if (res.status !== 401) return res;

    // Not logged in at all (public page): nothing to renew.
    if (!get('refreshToken')) return res;

    if (await refreshTokens()) {
      return send(get('accessToken'));
    }
    signOutAndReload();
    return res;
  };

  // Background renewal while the page is open.
  const renewIfDue = () => {
    if (!get('refreshToken')) return;
    const last = Number(get('tokenRefreshedAt')) || 0;
    if (Date.now() - last >= REFRESH_EVERY_MS - 5000) refreshTokens();
  };
  setInterval(() => { if (!document.hidden) renewIfDue(); }, REFRESH_EVERY_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renewIfDue(); });
}
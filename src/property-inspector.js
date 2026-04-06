/* global WebSocket */
(() => {
  let websocket = null;
  let uuid = null;
  let actionInfo = null;
  let settings = {};
  let tokenPoll = null;
  const VERCEL_OAUTH_BASE = 'https://your-project.vercel.app';
  const GOOGLE_CLIENT_ID = 'your-google-client-id.apps.googleusercontent.com';

  function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, inInfo) {
    uuid = inUUID;
    actionInfo = JSON.parse(inInfo || '{}');
    websocket = new WebSocket(`ws://127.0.0.1:${inPort}`);
    websocket.onopen = () => {
      websocket.send(JSON.stringify({ event: inRegisterEvent, uuid }));
      requestSettings();
    };
    websocket.onmessage = handleMessage;
  }

  function handleMessage(evt) {
    const msg = JSON.parse(evt.data);
    const { event, payload } = msg;
    switch (event) {
      case 'didReceiveSettings':
        settings = payload.settings || {};
        applySettings();
        break;
      default:
        break;
    }
  }

  function requestSettings() {
    send({ event: 'getSettings', context: uuid });
  }

  function send(payload) {
    websocket && websocket.send(JSON.stringify(payload));
  }

  function updateSetting(key, value) {
    settings = { ...settings, [key]: value };
    send({ event: 'setSettings', context: uuid, payload: settings });
  }

  function applySettings() {
    if (!settings.calendars || !settings.calendars.length) {
      settings.calendars = ['primary'];
      updateSetting('calendars', settings.calendars);
    }
    document.getElementById('calendars').value = (settings.calendars || []).join(', ');
        renderAuthStatus();
  }

  function bindInputs() {
    document.getElementById('calendars').addEventListener('input', (e) => {
      const value = e.target.value.split(',').map((v) => v.trim()).filter(Boolean);
      updateSetting('calendars', value);
    });
        document.getElementById('refresh').addEventListener('click', () => {
      send({ event: 'sendToPlugin', action: actionInfo?.action, context: uuid, payload: { type: 'refresh' } });
    });
    document.getElementById('connect-google').addEventListener('click', () => {
      startGoogleAuth();
    });
  }

  function renderAuthStatus() {
    const status = document.getElementById('auth-status');
    if (!hasConfiguredOAuth()) {
      status.textContent = 'OAuth template not configured yet';
      return;
    }
    if (settings.googleTokens && settings.googleTokens.access_token) {
      const email = settings.googleTokens.email;
      const label = email ? `Connected: Google Calendar (${email})` : 'Connected: Google Calendar';
      status.textContent = label;
    } else {
      status.textContent = 'Not connected to Google Calendar';
    }
  }

  function startGoogleAuth() {
    if (!hasConfiguredOAuth()) {
      renderAuthStatus();
      return;
    }
    if (VERCEL_OAUTH_BASE) {
      startGoogleAuthVercel();
      return;
    }
    const url = 'http://localhost:43123/start';
    window.open(url, '_blank');
    clearInterval(tokenPoll);
    tokenPoll = setInterval(async () => {
      try {
        const res = await fetch('http://localhost:43123/tokens');
        if (!res.ok) return;
        const data = await res.json();
        settings.googleTokens = data;
        const email = data.email;
        const label = email ? `Connected: Google Calendar (${email})` : 'Connected: Google Calendar';
        document.getElementById('auth-status').textContent = label;
        updateSetting('googleTokens', data);
        renderAuthStatus();
        clearInterval(tokenPoll);
      } catch (_) {
        // ignore polling errors
      }
    }, 2000);
  }

  function startGoogleAuthVercel() {
    const clientId = GOOGLE_CLIENT_ID;
    const existingRefreshToken = settings.googleTokens?.refresh_token || null;
    const existingEmail = settings.googleTokens?.email || null;
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    sha256(verifier).then((hash) => {
      const challenge = base64Url(hash);
      const state = base64Url(JSON.stringify({
        verifier,
        refreshToken: existingRefreshToken,
        email: existingEmail
      }));
      const redirectUri = `${VERCEL_OAUTH_BASE}/api/google/callback`;
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar.readonly openid email profile');
      authUrl.searchParams.set('access_type', 'offline');
      if (!existingRefreshToken) {
        authUrl.searchParams.set('prompt', 'consent');
      }
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', state);
      const popup = window.open(authUrl.toString(), '_blank');
      const handler = (event) => {
        if (event.origin !== VERCEL_OAUTH_BASE) return;
        if (!event.data || event.data.type !== 'googleTokens') return;
        const data = event.data.data;
        settings.googleTokens = data;
        updateSetting('googleTokens', data);
        renderAuthStatus();
        window.removeEventListener('message', handler);
        if (popup) popup.close();
      };
      window.addEventListener('message', handler);
    });
  }

  function hasConfiguredOAuth() {
    return (
      Boolean(VERCEL_OAUTH_BASE) &&
      Boolean(GOOGLE_CLIENT_ID) &&
      !VERCEL_OAUTH_BASE.includes('your-project.vercel.app') &&
      !GOOGLE_CLIENT_ID.includes('your-google-client-id')
    );
  }

  function base64Url(buffer) {
    let bytes = buffer;
    if (typeof buffer === 'string') {
      bytes = new TextEncoder().encode(buffer);
    }
    let str = '';
    bytes = new Uint8Array(bytes);
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function sha256(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    if (crypto.subtle) {
      return crypto.subtle.digest('SHA-256', data).then((buf) => new Uint8Array(buf));
    }
    return Promise.resolve(new Uint8Array());
  }

  document.addEventListener('DOMContentLoaded', bindInputs);
  window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;
})();

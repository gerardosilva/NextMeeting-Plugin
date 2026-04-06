/* global WebSocket */
(() => {
  const DEFAULT_OAUTH_BASE = 'https://your-project.vercel.app';
  const DEFAULT_GOOGLE_CLIENT_ID = 'your-google-client-id.apps.googleusercontent.com';
  const DEFAULT_MICROSOFT_CLIENT_ID = '';
  const DEFAULT_MICROSOFT_TENANT = 'common';

  let websocket = null;
  let uuid = null;
  let actionInfo = null;
  let settings = {};

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
    if (msg.event === 'didReceiveSettings') {
      settings = normalizeSettings(msg.payload.settings || {});
      applySettings();
    }
  }

  function requestSettings() {
    send({ event: 'getSettings', context: uuid });
  }

  function send(payload) {
    websocket && websocket.send(JSON.stringify(payload));
  }

  function saveSettings(nextSettings) {
    settings = normalizeSettings(nextSettings);
    send({ event: 'setSettings', context: uuid, payload: settings });
  }

  function updateSetting(key, value) {
    saveSettings({ ...settings, [key]: value });
    applySettings();
  }

  function applySettings() {
    document.getElementById('oauth-base').value = settings.oauthBase;
    document.getElementById('google-client-id').value = settings.googleClientId;
    document.getElementById('microsoft-client-id').value = settings.microsoftClientId;
    document.getElementById('microsoft-tenant').value = settings.microsoftTenant;
    renderAuthStatus();
    renderAccounts();
  }

  function bindInputs() {
    document.getElementById('oauth-base').addEventListener('change', (event) => {
      updateSetting('oauthBase', sanitizeUrl(event.target.value));
    });
    document.getElementById('google-client-id').addEventListener('change', (event) => {
      updateSetting('googleClientId', event.target.value.trim());
    });
    document.getElementById('microsoft-client-id').addEventListener('change', (event) => {
      updateSetting('microsoftClientId', event.target.value.trim());
    });
    document.getElementById('microsoft-tenant').addEventListener('change', (event) => {
      updateSetting('microsoftTenant', event.target.value.trim() || DEFAULT_MICROSOFT_TENANT);
    });
    document.getElementById('refresh').addEventListener('click', () => {
      send({ event: 'sendToPlugin', action: actionInfo?.action, context: uuid, payload: { type: 'refresh' } });
    });
    document.getElementById('connect-google').addEventListener('click', () => {
      startAuthFlow('google');
    });
    document.getElementById('connect-outlook').addEventListener('click', () => {
      startAuthFlow('microsoft');
    });
    document.getElementById('accounts').addEventListener('change', handleAccountChange);
    document.getElementById('accounts').addEventListener('click', handleAccountClick);
  }

  function handleAccountChange(event) {
    const accountId = event.target.dataset.accountId;
    if (!accountId) return;
    if (event.target.classList.contains('account-enabled')) {
      patchAccount(accountId, { enabled: event.target.checked });
      return;
    }
    if (event.target.classList.contains('account-calendars')) {
      const calendars = event.target.value.split(',').map((value) => value.trim()).filter(Boolean);
      const account = getAccount(accountId);
      patchAccount(accountId, { calendars: calendars.length ? calendars : defaultCalendars(account?.provider) });
    }
  }

  function handleAccountClick(event) {
    const accountId = event.target.dataset.accountId;
    if (!accountId) return;
    if (event.target.classList.contains('remove-account')) {
      removeAccount(accountId);
      return;
    }
    if (event.target.classList.contains('reauth-account')) {
      const account = getAccount(accountId);
      if (account) startAuthFlow(account.provider, accountId);
    }
  }

  function renderAuthStatus() {
    const status = document.getElementById('auth-status');
    const connected = settings.accounts.filter((account) => account.tokens?.access_token).length;
    const reconnect = settings.accounts.filter((account) => account.needsReconnect).length;
    const parts = [];
    if (connected) parts.push(`${connected} connected`);
    if (reconnect) parts.push(`${reconnect} need reconnect`);
    status.textContent = parts.length ? parts.join(' · ') : 'No connected accounts yet';
  }

  function renderAccounts() {
    const container = document.getElementById('accounts');
    if (!settings.accounts.length) {
      container.innerHTML = '<div class="empty">Connect Google or Outlook to add an account.</div>';
      return;
    }

    container.innerHTML = settings.accounts.map((account) => {
      const email = account.email || 'No email yet';
      const provider = account.provider === 'microsoft' ? 'Outlook' : 'Google';
      const status = account.needsReconnect
        ? 'Reconnect required'
        : account.tokens?.access_token
          ? 'Connected'
          : 'Stored without token';
      const placeholder = account.provider === 'microsoft'
        ? 'default, AAMkAG...'
        : 'primary, team@group.calendar.google.com';
      return `<div class="account-card">
        <div class="account-head">
          <div>
            <strong>${escapeHtml(account.label || email)}</strong>
            <div class="meta">${escapeHtml(provider)} · ${escapeHtml(email)}</div>
            <div class="meta">${escapeHtml(status)}</div>
          </div>
          <div class="account-actions">
            <button type="button" class="reauth-account secondary" data-account-id="${escapeHtml(account.id)}">Reconnect</button>
            <button type="button" class="remove-account danger" data-account-id="${escapeHtml(account.id)}">Remove</button>
          </div>
        </div>
        <label class="inline-toggle">
          <input type="checkbox" class="account-enabled" data-account-id="${escapeHtml(account.id)}" ${account.enabled !== false ? 'checked' : ''}>
          Enabled
        </label>
        <label>Calendars</label>
        <textarea class="account-calendars" data-account-id="${escapeHtml(account.id)}" placeholder="${escapeHtml(placeholder)}">${escapeHtml((account.calendars || []).join(', '))}</textarea>
      </div>`;
    }).join('');
  }

  function startAuthFlow(provider, accountId = null) {
    const config = getOauthConfig();
    if (!config.oauthBase) {
      renderAuthStatus();
      return;
    }

    if (provider === 'google' && !config.googleClientId) {
      renderAuthStatus();
      return;
    }

    if (provider === 'microsoft' && !config.microsoftClientId) {
      renderAuthStatus();
      return;
    }

    const account = accountId ? getAccount(accountId) : null;
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    sha256(verifier).then((hash) => {
      const challenge = base64Url(hash);
      const state = base64Url(JSON.stringify({
        verifier,
        provider,
        accountId,
        refreshToken: account?.tokens?.refresh_token || null,
        email: account?.email || null
      }));
      const authUrl = buildAuthUrl(provider, challenge, state, config);
      const popup = window.open(authUrl.toString(), '_blank');
      const handler = (event) => {
        if (event.origin !== config.oauthBase) return;
        if (!event.data) return;
        if (event.data.type !== 'calendarTokens' && event.data.type !== 'googleTokens') return;
        const data = event.data.data;
        if (!data?.provider) return;
        upsertAccountFromTokens(data, accountId);
        window.removeEventListener('message', handler);
        if (popup) popup.close();
      };
      window.addEventListener('message', handler);
    });
  }

  function buildAuthUrl(provider, challenge, state, config) {
    if (provider === 'microsoft') {
      const tenant = config.microsoftTenant || DEFAULT_MICROSOFT_TENANT;
      const authUrl = new URL(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`);
      authUrl.searchParams.set('client_id', config.microsoftClientId);
      authUrl.searchParams.set('redirect_uri', `${config.oauthBase}/api/microsoft/callback`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('response_mode', 'query');
      authUrl.searchParams.set('scope', 'openid offline_access profile email https://graph.microsoft.com/Calendars.Read');
      authUrl.searchParams.set('prompt', 'select_account');
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', state);
      return authUrl;
    }

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', config.googleClientId);
    authUrl.searchParams.set('redirect_uri', `${config.oauthBase}/api/google/callback`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar.readonly openid email profile');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'select_account consent');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    return authUrl;
  }

  function upsertAccountFromTokens(tokens, requestedAccountId) {
    const provider = normalizeProvider(tokens.provider);
    const email = tokens.email || null;
    const existing = requestedAccountId
      ? getAccount(requestedAccountId)
      : settings.accounts.find((account) => account.provider === provider && account.email && email && account.email === email);
    const account = normalizeAccount({
      ...(existing || {}),
      id: existing?.id || requestedAccountId || makeAccountId(provider, email),
      provider,
      email,
      label: existing?.label || tokens.label || email || providerName(provider),
      enabled: true,
      needsReconnect: false,
      calendars: existing?.calendars || defaultCalendars(provider),
      tokens: {
        ...(existing?.tokens || {}),
        ...tokens
      }
    });

    const accounts = [...settings.accounts.filter((item) => item.id !== account.id), account];
    saveSettings({ ...settings, accounts });
    applySettings();
  }

  function patchAccount(accountId, patch) {
    const accounts = settings.accounts.map((account) => account.id === accountId
      ? normalizeAccount({ ...account, ...patch })
      : account);
    saveSettings({ ...settings, accounts });
  }

  function removeAccount(accountId) {
    const accounts = settings.accounts.filter((account) => account.id !== accountId);
    saveSettings({ ...settings, accounts, googleTokens: null });
    applySettings();
  }

  function getAccount(accountId) {
    return settings.accounts.find((account) => account.id === accountId) || null;
  }

  function normalizeSettings(rawSettings) {
    const nextSettings = { ...rawSettings };
    nextSettings.oauthBase = sanitizeUrl(nextSettings.oauthBase || DEFAULT_OAUTH_BASE);
    nextSettings.googleClientId = (nextSettings.googleClientId || DEFAULT_GOOGLE_CLIENT_ID).trim();
    nextSettings.microsoftClientId = (nextSettings.microsoftClientId || DEFAULT_MICROSOFT_CLIENT_ID).trim();
    nextSettings.microsoftTenant = (nextSettings.microsoftTenant || DEFAULT_MICROSOFT_TENANT).trim() || DEFAULT_MICROSOFT_TENANT;

    const hasExplicitAccounts = Array.isArray(nextSettings.accounts);
    let accounts = hasExplicitAccounts
      ? nextSettings.accounts.map(normalizeAccount).filter(Boolean)
      : [];

    if (!hasExplicitAccounts && !accounts.length && nextSettings.googleTokens?.access_token) {
      accounts.push(normalizeAccount({
        provider: 'google',
        calendars: nextSettings.calendars,
        tokens: nextSettings.googleTokens
      }));
    }

    nextSettings.accounts = accounts;
    if (hasExplicitAccounts) {
      nextSettings.googleTokens = null;
      nextSettings.calendars = undefined;
    }
    return nextSettings;
  }

  function normalizeAccount(account) {
    const provider = normalizeProvider(account.provider || account.tokens?.provider);
    if (!provider) return null;
    const tokens = account.tokens
      ? {
          ...account.tokens,
          provider: providerName(provider),
          email: account.tokens.email || account.email || null
        }
      : null;
    const email = account.email || tokens?.email || null;
    return {
      id: account.id || makeAccountId(provider, email),
      provider,
      label: account.label || email || providerName(provider),
      email,
      enabled: account.enabled !== false,
      needsReconnect: Boolean(account.needsReconnect) && !tokens?.access_token,
      calendars: Array.isArray(account.calendars) && account.calendars.length
        ? account.calendars
        : defaultCalendars(provider),
      tokens
    };
  }

  function normalizeProvider(provider) {
    const value = `${provider || ''}`.toLowerCase();
    if (value === 'google') return 'google';
    if (value === 'microsoft' || value === 'outlook') return 'microsoft';
    return null;
  }

  function defaultCalendars(provider) {
    return [provider === 'microsoft' ? 'default' : 'primary'];
  }

  function providerName(provider) {
    return provider === 'microsoft' ? 'Outlook' : 'Google';
  }

  function makeAccountId(provider, email) {
    const suffix = (email || `${Date.now()}`).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    return `${provider}-${suffix}`;
  }

  function getOauthConfig() {
    return {
      oauthBase: sanitizeUrl(settings.oauthBase),
      googleClientId: settings.googleClientId.trim(),
      microsoftClientId: settings.microsoftClientId.trim(),
      microsoftTenant: settings.microsoftTenant.trim() || DEFAULT_MICROSOFT_TENANT
    };
  }

  function sanitizeUrl(value) {
    return `${value || ''}`.trim().replace(/\/+$/, '');
  }

  function base64Url(buffer) {
    let bytes = buffer;
    if (typeof buffer === 'string') {
      bytes = new TextEncoder().encode(buffer);
    }
    let str = '';
    bytes = new Uint8Array(bytes);
    for (let i = 0; i < bytes.length; i += 1) str += String.fromCharCode(bytes[i]);
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

  function escapeHtml(value) {
    return `${value || ''}`
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  document.addEventListener('DOMContentLoaded', bindInputs);
  window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;
})();

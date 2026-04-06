/* global WebSocket, Buffer */
// Stream Deck Next Meeting plugin runtime.
(() => {
  const UPDATE_INTERVAL_MS = 10000;
  const SOON_THRESHOLD_MIN = 15;
  const NOW_THRESHOLD_MIN = 1;
  const OUTLOOK_WINDOW_DAYS = 30;
  const DEFAULT_OAUTH_BASE = 'https://your-project.vercel.app';
  const DEFAULT_GOOGLE_CLIENT_ID = 'your-google-client-id.apps.googleusercontent.com';
  const DEFAULT_MICROSOFT_CLIENT_ID = '';
  const DEFAULT_MICROSOFT_TENANT = 'common';

  let websocket = null;
  let pluginUUID = null;
  const instances = new Map();

  const statusColors = {
    free: '#263238',
    upcoming: '#1976D2',
    imminent: '#FBC02D',
    live: '#D32F2F',
    error: '#B71C1C'
  };

  function log() {}

  function connectElgatoStreamDeckSocket(inPort, inPluginUUID, inRegisterEvent) {
    pluginUUID = inPluginUUID;
    websocket = new WebSocket(`ws://127.0.0.1:${inPort}`);
    websocket.onopen = () => websocket.send(JSON.stringify({ event: inRegisterEvent, uuid: pluginUUID }));
    websocket.onmessage = handleMessage;
    websocket.onclose = () => log('Socket closed');
    websocket.onerror = (err) => log('Socket error', err);
  }

  function handleMessage(evt) {
    const msg = JSON.parse(evt.data);
    const { event, context, payload } = msg;
    switch (event) {
      case 'willAppear':
        handleWillAppear(context, payload);
        break;
      case 'keyUp':
        handleKeyUp(context);
        break;
      case 'didReceiveSettings':
        updateSettings(context, payload.settings || {});
        break;
      case 'sendToPlugin':
        handleSendToPlugin(context, payload);
        break;
      default:
        break;
    }
  }

  function handleWillAppear(context, payload) {
    const originalSettings = payload.settings || {};
    const settings = normalizeSettings(originalSettings);
    const instance = {
      context,
      settings,
      timer: null,
      cachedMeeting: null
    };
    instances.set(context, instance);
    persistNormalizedSettings(instance, originalSettings);
    setTitle(context, 'Loading...');
    startUpdating(instance);
  }

  async function handleKeyUp(context) {
    const instance = instances.get(context);
    if (!instance) return;
    const meeting = await fetchAndRender(instance, true);
    if (meeting && meeting.joinUrl) {
      sendToStreamDeck({ event: 'openUrl', payload: { url: meeting.joinUrl } }, context);
    }
  }

  function handleSendToPlugin(context, payload) {
    if (payload?.type === 'refresh') {
      const instance = instances.get(context);
      if (instance) fetchAndRender(instance, true);
    }
  }

  function updateSettings(context, newSettings) {
    const instance = instances.get(context);
    if (!instance) return;
    instance.settings = normalizeSettings({ ...instance.settings, ...newSettings });
    startUpdating(instance);
  }

  function startUpdating(instance) {
    clearInterval(instance.timer);
    fetchAndRender(instance, true);
    instance.timer = setInterval(() => fetchAndRender(instance, false), UPDATE_INTERVAL_MS);
  }

  async function fetchAndRender(instance) {
    try {
      const meeting = await getNextMeeting(instance);
      instance.cachedMeeting = meeting;
      render(instance, meeting);
      return meeting;
    } catch (err) {
      renderError(instance, err);
      return null;
    }
  }

  async function getNextMeeting(instance) {
    const accounts = getUsableAccounts(instance.settings);
    if (!accounts.length) {
      return buildEmptyState('No Accounts', 'Connect calendar');
    }

    const meetings = [];
    let hadConnectionError = false;
    let lastConnectionError = null;
    let reconnectCount = 0;

    for (const currentAccount of accounts) {
      let account = currentAccount;
      if (!account.tokens?.access_token && !account.tokens?.refresh_token) {
        if (account.needsReconnect) reconnectCount += 1;
        continue;
      }

      try {
        let tokens = account.tokens;
        if (tokenExpired(tokens)) {
          tokens = await refreshAccountTokens(instance, account);
          if (!tokens) {
            reconnectCount += 1;
            continue;
          }
          account = getAccountById(instance.settings, account.id) || { ...account, tokens };
        }

        account = await ensureAccountIdentity(instance, account);
        const meeting = await fetchNextMeetingForAccount(instance.settings, account);
        if (meeting) meetings.push(meeting);
      } catch (err) {
        if (err?.message === 'unauthorized') {
          const refreshed = await refreshAccountTokens(instance, account);
          if (!refreshed) {
            reconnectCount += 1;
            continue;
          }
          account = getAccountById(instance.settings, account.id) || { ...account, tokens: refreshed };
          const meeting = await fetchNextMeetingForAccount(instance.settings, account);
          if (meeting) {
            meetings.push(meeting);
            continue;
          }
        }
        hadConnectionError = true;
        lastConnectionError = err;
      }
    }

    if (meetings.length) return pickEarliest(meetings);
    if (reconnectCount) {
      return buildEmptyState('Reconnect', reconnectCount === 1 ? 'Auth expired' : `${reconnectCount} accounts`);
    }
    if (hadConnectionError) throw lastConnectionError || new Error('connection');
    return buildEmptyState('No Events', 'All clear');
  }

  async function refreshAccountTokens(instance, account) {
    if (!account.tokens?.refresh_token) return null;
    const oauthBase = getOauthBase(instance.settings);
    if (!oauthBase) return null;

    const route = account.provider === 'microsoft' ? 'microsoft' : 'google';
    try {
      const data = await httpJson(`${oauthBase}/api/${route}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: account.tokens.refresh_token })
      });
      const updatedAccount = {
        ...account,
        needsReconnect: false,
        tokens: mergeTokens(account.tokens, data)
      };
      persistAccount(instance, updatedAccount);
      return updatedAccount.tokens;
    } catch (err) {
      err = annotateError(err, `${route}-refresh`);
      if (shouldReconnect(err?.status, err?.body)) {
        expireAccount(instance, account.id);
        return null;
      }
      if (err?.code === 'reauth_required') {
        expireAccount(instance, account.id);
        return null;
      }
      if (err?.message === 'unauthorized') throw err;
      throw err?.stage ? err : annotateError(new Error('connection'), `${route}-refresh`, err?.detail || err?.status || '');
    }
  }

  async function ensureAccountIdentity(instance, account) {
    if (account.email && account.label && account.tokens?.email) return account;
    const headers = { Authorization: `Bearer ${account.tokens.access_token}` };

    try {
      let profile = null;
      if (account.provider === 'microsoft') {
        profile = await httpJson('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', { headers });
      } else {
        profile = await httpJson('https://www.googleapis.com/oauth2/v3/userinfo', { headers });
      }

      const email = profile?.email || profile?.mail || profile?.userPrincipalName || account.email || account.tokens?.email || null;
      const label = profile?.displayName || email || account.label || providerName(account.provider);
      const updatedAccount = {
        ...account,
        email,
        label,
        tokens: {
          ...account.tokens,
          email
        }
      };
      persistAccount(instance, updatedAccount);
      return updatedAccount;
    } catch (err) {
      log('ensureAccountIdentity failed', err);
      return account;
    }
  }

  async function fetchNextMeetingForAccount(settings, account) {
    if (account.provider === 'microsoft') {
      return fetchMicrosoftNext(settings, account);
    }
    return fetchGoogleNext(settings, account);
  }

  async function fetchGoogleNext(settings, account) {
    const calendars = normalizeCalendars(account.calendars, 'google');
    const proxiedMeeting = await fetchProxiedNextMeeting('google', account, calendars, getOauthBase(settings));
    if (proxiedMeeting) return annotateMeeting(proxiedMeeting, account);
    const meetings = [];
    let hadError = false;
    let lastError = null;
    for (const cal of calendars) {
      try {
        const evt = await fetchGoogleCalendar(cal, account.tokens.access_token);
        if (evt) meetings.push(evt);
      } catch (err) {
        if (err?.message === 'unauthorized') throw err;
        hadError = true;
        lastError = annotateError(err, 'google-direct');
      }
    }
    if (!meetings.length && hadError) throw lastError || new Error('connection');
    if (!meetings.length) return null;
    return annotateMeeting(pickEarliest(meetings), account);
  }

  async function fetchMicrosoftNext(settings, account) {
    const calendars = normalizeCalendars(account.calendars, 'microsoft');
    const proxiedMeeting = await fetchProxiedNextMeeting('microsoft', account, calendars, getOauthBase(settings));
    if (proxiedMeeting) return annotateMeeting(proxiedMeeting, account);
    const meetings = [];
    let hadError = false;
    let lastError = null;
    const startDateTime = new Date().toISOString();
    const endDateTime = new Date(Date.now() + OUTLOOK_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

    for (const calendarId of calendars) {
      try {
        const event = await fetchMicrosoftCalendar(calendarId, account.tokens.access_token, startDateTime, endDateTime);
        if (event) meetings.push(event);
      } catch (err) {
        if (err?.message === 'unauthorized') throw err;
        hadError = true;
        lastError = annotateError(err, 'microsoft-direct');
      }
    }

    if (!meetings.length && hadError) throw lastError || new Error('connection');
    if (!meetings.length) return null;
    return annotateMeeting(pickEarliest(meetings), account);
  }

  function annotateMeeting(meeting, account) {
    return {
      ...meeting,
      provider: providerName(account.provider),
      accountLabel: account.label || account.email || providerName(account.provider)
    };
  }

  async function fetchProxiedNextMeeting(provider, account, calendars, oauthBase) {
    if (!oauthBase || !account.tokens?.access_token) return null;
    try {
      const payload = await httpJson(`${oauthBase}/api/${provider}/next`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: account.tokens.access_token,
          calendars
        })
      });
      return payload?.meeting || null;
    } catch (err) {
      if (err?.status === 404 || err?.status === 405) return null;
      if (err?.message === 'unauthorized' || err?.message === 'connection') throw err;
      if (err?.status === 401) throw annotateError(new Error('unauthorized'), `${provider}-proxy`, `${err.status}`);
      if (err?.status) {
        log('proxy next error', provider, err.status, err.body || '');
        throw annotateError(new Error('connection'), `${provider}-proxy`, `${err.status}`);
      }
      if (err?.message === 'network error') throw annotateError(new Error('connection'), `${provider}-proxy`, 'network');
      return null;
    }
  }

  async function fetchGoogleCalendar(calendarId, accessToken) {
    const params = new URLSearchParams({
      orderBy: 'startTime',
      singleEvents: 'true',
      timeMin: new Date().toISOString(),
      maxResults: '1'
    });
    const data = await httpJson(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!data.items || !data.items.length) return null;
    return normalizeGoogleEvent(data.items[0]);
  }

  async function fetchMicrosoftCalendar(calendarId, accessToken, startDateTime, endDateTime) {
    const params = new URLSearchParams({
      startDateTime,
      endDateTime,
      $top: '10',
      $orderby: 'start/dateTime',
      $select: 'subject,start,end,location,locations,bodyPreview,isOnlineMeeting,onlineMeeting,onlineMeetingUrl,webLink'
    });
    const basePath = calendarId === 'default'
      ? 'https://graph.microsoft.com/v1.0/me/calendarView'
      : `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView`;
    const data = await httpJson(`${basePath}?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.timezone="UTC"'
      }
    });
    if (!data.value || !data.value.length) return null;

    const events = data.value
      .map(normalizeMicrosoftEvent)
      .filter(Boolean);

    if (!events.length) return null;
    return pickEarliest(events);
  }

  function normalizeGoogleEvent(ev) {
    const start = ev.start?.dateTime || ev.start?.date;
    const end = ev.end?.dateTime || ev.end?.date || start;
    return {
      title: ev.summary || 'Meeting',
      start,
      end,
      joinUrl: ev.hangoutLink || extractJoinUrl([ev.location, ev.description]),
      status: determineStatus(start, end)
    };
  }

  function normalizeMicrosoftEvent(ev) {
    const start = toIsoDateTime(ev.start);
    const end = toIsoDateTime(ev.end) || start;
    if (!start) return null;
    return {
      title: ev.subject || 'Meeting',
      start,
      end,
      joinUrl: ev.onlineMeeting?.joinUrl || ev.onlineMeetingUrl || extractJoinUrl([
        ev.location?.displayName,
        ...(ev.locations || []).map((location) => location?.displayName),
        ev.bodyPreview
      ]),
      status: determineStatus(start, end)
    };
  }

  function toIsoDateTime(value) {
    if (!value?.dateTime) return null;
    if (/[zZ]|[+-]\d\d:\d\d$/.test(value.dateTime)) return value.dateTime;
    if (value.timeZone === 'UTC') return `${value.dateTime}Z`;
    return value.dateTime;
  }

  function extractJoinUrl(fields) {
    const source = (fields || []).filter(Boolean).join(' ');
    const match = source.match(/https?:\/\/[^\s>"]+/);
    return match ? match[0] : null;
  }

  async function httpJson(url, options = {}) {
    if (typeof XMLHttpRequest !== 'undefined') {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(options.method || 'GET', url);
        const headers = options.headers || {};
        Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
        xhr.onload = () => {
          if (xhr.status === 401) return reject(new Error('unauthorized'));
          if (xhr.status < 200 || xhr.status >= 300) return reject(createHttpError(xhr.status, xhr.responseText));
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (err) {
            reject(err);
          }
        };
        xhr.onerror = () => reject(annotateError(new Error('network error'), 'xhr', 'network'));
        xhr.send(options.body || null);
      });
    }

    if (typeof fetch === 'function') {
      const res = await fetch(url, options);
      if (res.status === 401) throw new Error('unauthorized');
      if (!res.ok) {
        const text = await res.text();
        log('httpJson error', url, res.status, text);
        throw createHttpError(res.status, text);
      }
      return res.json();
    }

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(options.method || 'GET', url);
      const headers = options.headers || {};
      Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
      xhr.onload = () => {
        if (xhr.status === 401) return reject(new Error('unauthorized'));
        if (xhr.status < 200 || xhr.status >= 300) return reject(createHttpError(xhr.status, xhr.responseText));
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (err) {
          reject(err);
        }
      };
      xhr.onerror = () => reject(new Error('network error'));
      xhr.send(options.body || null);
    });
  }

  function createHttpError(status, body) {
    const err = new Error(`http ${status}`);
    err.status = status;
    err.body = body || '';
    return err;
  }

  function annotateError(err, stage, detail) {
    if (!err || typeof err !== 'object') return err;
    if (!err.stage) err.stage = stage;
    if (!err.detail && detail) err.detail = detail;
    if (!err.detail && err.status) err.detail = `${err.status}`;
    return err;
  }

  function persistNormalizedSettings(instance, previousSettings) {
    if (JSON.stringify(instance.settings) !== JSON.stringify(previousSettings || {})) {
      saveSettings(instance.context, instance.settings);
    }
  }

  function persistAccount(instance, nextAccount) {
    instance.settings = normalizeSettings({
      ...instance.settings,
      accounts: (instance.settings.accounts || []).map((account) => account.id === nextAccount.id ? nextAccount : account)
    });
    saveSettings(instance.context, instance.settings);
  }

  function expireAccount(instance, accountId) {
    instance.settings = normalizeSettings({
      ...instance.settings,
      accounts: (instance.settings.accounts || []).map((account) => account.id === accountId
        ? {
            ...account,
            needsReconnect: true,
            tokens: account.tokens
              ? {
                  provider: account.tokens.provider,
                  email: account.tokens.email || account.email || null,
                  refresh_token: account.tokens.refresh_token || null
                }
              : null
          }
        : account)
    });
    saveSettings(instance.context, instance.settings);
  }

  function getUsableAccounts(settings) {
    return (settings.accounts || []).filter((account) => account.enabled !== false);
  }

  function getAccountById(settings, accountId) {
    return (settings.accounts || []).find((account) => account.id === accountId) || null;
  }

  function normalizeSettings(rawSettings) {
    const settings = { ...rawSettings };
    settings.oauthBase = settings.oauthBase || DEFAULT_OAUTH_BASE;
    settings.googleClientId = settings.googleClientId || DEFAULT_GOOGLE_CLIENT_ID;
    settings.microsoftClientId = settings.microsoftClientId || DEFAULT_MICROSOFT_CLIENT_ID;
    settings.microsoftTenant = settings.microsoftTenant || DEFAULT_MICROSOFT_TENANT;

    const hasExplicitAccounts = Array.isArray(settings.accounts);
    let accounts = hasExplicitAccounts
      ? settings.accounts.map(normalizeAccount).filter(Boolean)
      : [];

    if (!hasExplicitAccounts && !accounts.length && settings.googleTokens?.access_token) {
      accounts.push(normalizeAccount({
        provider: 'google',
        calendars: settings.calendars,
        tokens: settings.googleTokens
      }));
    }

    settings.accounts = accounts;
    if (hasExplicitAccounts) {
      settings.googleTokens = null;
      settings.calendars = undefined;
    }
    return settings;
  }

  function normalizeAccount(account) {
    const provider = normalizeProvider(account.provider || account.tokens?.provider);
    if (!provider) return null;
    const tokens = normalizeTokens(account.tokens, provider);
    const email = account.email || tokens?.email || null;
    const label = account.label || email || providerName(provider);
    return {
      id: account.id || makeAccountId(provider, email),
      provider,
      label,
      email,
      enabled: account.enabled !== false,
      needsReconnect: Boolean(account.needsReconnect) && !tokens?.access_token,
      calendars: normalizeCalendars(account.calendars, provider),
      tokens
    };
  }

  function normalizeTokens(tokens, provider) {
    if (!tokens) return null;
    return {
      ...tokens,
      provider: providerName(provider),
      email: tokens.email || null
    };
  }

  function normalizeProvider(provider) {
    const value = `${provider || ''}`.toLowerCase();
    if (value === 'google') return 'google';
    if (value === 'microsoft' || value === 'outlook') return 'microsoft';
    return null;
  }

  function normalizeCalendars(calendars, provider) {
    const values = Array.isArray(calendars)
      ? calendars
      : typeof calendars === 'string'
        ? calendars.split(',')
        : [];
    const cleaned = values.map((value) => `${value}`.trim()).filter(Boolean);
    if (cleaned.length) return cleaned;
    return [provider === 'microsoft' ? 'default' : 'primary'];
  }

  function makeAccountId(provider, email) {
    const suffix = (email || `${Date.now()}`).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    return `${provider}-${suffix}`;
  }

  function providerName(provider) {
    return provider === 'microsoft' ? 'Outlook' : 'Google';
  }

  function getOauthBase(settings) {
    const value = `${settings.oauthBase || ''}`.trim();
    return value.replace(/\/+$/, '');
  }

  function mergeTokens(previousTokens, nextTokens) {
    const now = Math.floor(Date.now() / 1000);
    return {
      ...previousTokens,
      ...nextTokens,
      refresh_token: nextTokens.refresh_token || previousTokens.refresh_token,
      scope: nextTokens.scope || previousTokens.scope,
      email: nextTokens.email || previousTokens.email,
      expires_at: nextTokens.expires_at || (nextTokens.expires_in ? now + nextTokens.expires_in : previousTokens.expires_at)
    };
  }

  function tokenExpired(tokens) {
    if (!tokens?.expires_at) return false;
    const now = Math.floor(Date.now() / 1000);
    return Number(tokens.expires_at) <= now + 60;
  }

  function shouldReconnect(status, body) {
    const text = `${body || ''}`.toLowerCase();
    return status === 400 && (
      text.includes('invalid_grant') ||
      text.includes('invalid_request') ||
      text.includes('token has been expired or revoked') ||
      text.includes('malformed')
    );
  }

  function buildEmptyState(title, subtitle) {
    return {
      title,
      provider: 'Calendar',
      start: null,
      end: null,
      joinUrl: null,
      status: title === 'Reconnect' ? 'live' : 'free',
      subtitleOverride: subtitle
    };
  }

  function pickEarliest(meetings) {
    const now = Date.now();
    const sorted = [...meetings].sort((a, b) => new Date(a.start) - new Date(b.start));
    const next = sorted.find((meeting) => new Date(meeting.end || meeting.start).getTime() >= now);
    if (!next) return buildEmptyState('No Events', 'All clear');
    return {
      ...next,
      status: determineStatus(next.start, next.end)
    };
  }

  function determineStatus(start, end) {
    if (!start) return 'free';
    const now = Date.now();
    const startTs = new Date(start).getTime();
    const endTs = end ? new Date(end).getTime() : startTs;
    if (now >= startTs && now <= endTs) return 'live';
    const minsUntil = (startTs - now) / 60000;
    if (minsUntil <= NOW_THRESHOLD_MIN) return 'imminent';
    if (minsUntil <= SOON_THRESHOLD_MIN) return 'upcoming';
    return 'free';
  }

  function render(instance, meeting) {
    const status = meeting.status || determineStatus(meeting.start, meeting.end);
    const lines = buildLines(meeting);
    const svg = buildSvgTile(lines.top, lines.middle, lines.bottom, status);
    setImage(instance.context, svg);
    setTitle(instance.context, '');
  }

  function renderError(instance, err) {
    const msg = err?.message || '';
    const title = err?.stage ? truncate(err.stage, 16) : (msg === 'connection' ? 'Offline' : 'Error');
    const subtitle = err?.detail
      ? truncate(err.detail, 24)
      : (msg === 'connection' ? 'Check network' : (msg ? msg.slice(0, 24) : 'Check auth'));
    const svg = buildSvgTile('Error', title, subtitle, 'error');
    setImage(instance.context, svg);
    setTitle(instance.context, '');
  }

  function buildLines(meeting) {
    if (meeting.subtitleOverride) {
      return {
        top: truncate(meeting.accountLabel || meeting.provider || 'Calendar', 18),
        middle: truncate(meeting.title || 'Reconnect', 16),
        bottom: truncate(meeting.subtitleOverride, 18)
      };
    }
    if (!meeting.start) {
      return {
        top: truncate(meeting.accountLabel || meeting.provider || 'Calendar', 18),
        middle: truncate(meeting.title || 'No Events', 16),
        bottom: truncate('All clear', 18)
      };
    }

    const status = meeting.status || determineStatus(meeting.start, meeting.end);
    const start = new Date(meeting.start);
    const end = meeting.end ? new Date(meeting.end) : null;
    const now = Date.now();
    const startTs = start.getTime();
    const endTs = end ? end.getTime() : startTs;
    let subtitle = '';
    if (status === 'live') {
      const minsLeft = Math.max(0, Math.round((endTs - now) / 60000));
      subtitle = minsLeft <= 1 ? 'ending' : `${minsLeft}m left`;
    } else if (status === 'imminent' || status === 'upcoming') {
      const mins = Math.max(0, Math.round((startTs - now) / 60000));
      subtitle = mins <= 1 ? 'now' : `in ${mins}m`;
    } else {
      subtitle = formatTime(start);
    }

    return {
      top: truncate(meeting.accountLabel || meeting.provider || 'Calendar', 18),
      middle: truncate(meeting.title || 'Meeting', 16),
      bottom: truncate(subtitle, 18)
    };
  }

  function formatTime(date) {
    const hours = date.getHours();
    const mins = `${date.getMinutes()}`.padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const hour12 = hours % 12 === 0 ? 12 : hours % 12;
    return `${hour12}:${mins} ${ampm}`;
  }

  function buildSvgTile(top, middle, bottom, status) {
    const bg = statusColors[status] || statusColors.free;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='144' height='144'>` +
      `<rect width='144' height='144' rx='16' ry='16' fill='${bg}'/>` +
      `<text x='12' y='24' font-family='Arial, sans-serif' font-size='12' fill='#FFFFFF' opacity='0.88'>${escapeSvg(top)}</text>` +
      `<text x='12' y='72' font-family='Arial, sans-serif' font-size='20' fill='#FFFFFF'>${escapeSvg(middle)}</text>` +
      `<text x='12' y='116' font-family='Arial, sans-serif' font-size='16' fill='#FFFFFF' opacity='0.92'>${escapeSvg(bottom)}</text>` +
      `</svg>`;
    return `data:image/svg+xml;base64,${toBase64(svg)}`;
  }

  function toBase64(str) {
    if (typeof btoa === 'function') {
      return btoa(unescape(encodeURIComponent(str)));
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(str, 'utf8').toString('base64');
    }
    return '';
  }

  function escapeSvg(value) {
    return (value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function truncate(str, max) {
    if (!str) return '';
    return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
  }

  function setTitle(context, title) {
    sendToStreamDeck({
      event: 'setTitle',
      context,
      payload: { title, target: 0 }
    });
  }

  function setImage(context, image) {
    sendToStreamDeck({
      event: 'setImage',
      context,
      payload: { image }
    });
  }

  function saveSettings(context, settings) {
    sendToStreamDeck({
      event: 'setSettings',
      context,
      payload: settings
    });
  }

  function sendToStreamDeck(message, contextOverride) {
    const msg = { ...message };
    if (!msg.context && contextOverride) msg.context = contextOverride;
    websocket && websocket.send(JSON.stringify(msg));
  }

  window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;
})();

/* global WebSocket, Buffer */
// Stream Deck Next Meeting plugin runtime.
(() => {
  const UPDATE_INTERVAL_MS = 10000;
  const SOON_THRESHOLD_MIN = 15;
  const NOW_THRESHOLD_MIN = 1;

  let websocket = null;
  let pluginUUID = null;
  const instances = new Map(); // context -> state

  const statusColors = {
    free: '#263238',
    upcoming: '#1976D2',
    imminent: '#FBC02D',
    live: '#D32F2F'
  };

  function log() {}

  function connectElgatoStreamDeckSocket(inPort, inPluginUUID, inRegisterEvent, inInfo) {
    pluginUUID = inPluginUUID;
    websocket = new WebSocket(`ws://127.0.0.1:${inPort}`);
    websocket.onopen = () => websocket.send(JSON.stringify({ event: inRegisterEvent, uuid: pluginUUID }));
    websocket.onmessage = handleMessage;
    websocket.onclose = () => log('Socket closed');
    websocket.onerror = (err) => log('Socket error', err);
    log('Plugin connected');
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
    const settings = payload.settings || {};
    const instance = {
      context,
      settings,
      timer: null,
      cachedMeeting: null
    };
    instances.set(context, instance);
    setTitle(context, 'Loading...');
    startUpdating(instance);
  }

  function handleKeyUp(context) {
    const instance = instances.get(context);
    if (!instance || !instance.cachedMeeting || !instance.cachedMeeting.joinUrl) return;
    sendToStreamDeck({ event: 'openUrl', payload: { url: instance.cachedMeeting.joinUrl } }, context);
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
    instance.settings = { ...instance.settings, ...newSettings };
    startUpdating(instance);
  }

  function startUpdating(instance) {
    clearInterval(instance.timer);
    fetchAndRender(instance, true);
    instance.timer = setInterval(() => fetchAndRender(instance, false), UPDATE_INTERVAL_MS);
  }

  async function fetchAndRender(instance, force) {
    try {
      const meeting = await getNextMeeting(instance);
      instance.cachedMeeting = meeting;
      render(instance, meeting);
    } catch (err) {
      renderError(instance, err);
    }
  }

  async function getNextMeeting(instance) {
    const { settings } = instance;
    if (settings.googleTokens && settings.googleTokens.access_token) {
      try {
        if (!settings.googleTokens.email) {
          const updated = await ensureGoogleEmail(instance, settings.googleTokens);
          if (updated) {
            settings.googleTokens = updated;
            saveSettings(instance.context, settings);
            log('email filled', updated.email);
          }
        }
        const meeting = await fetchGoogleNext(instance);
        log('fetchGoogleNext result', meeting);
        if (meeting) return meeting;
      } catch (err) {
        }
    }
    return {
      title: 'No meetings',
      provider: 'Google',
      start: null,
      end: null,
      joinUrl: null,
      status: 'free'
    };
  }

  async function refreshGoogleToken(tokens) {
    throw new Error('reauth');
  }

  async function fetchGoogleNext(instance) {

    const now = Math.floor(Date.now() / 1000);
    if (tokens.expires_at && tokens.expires_at < now + 60 && tokens.refresh_token && tokens.client_id) {
      try {
        tokens = await refreshGoogleToken(tokens);
        saveSettings(instance.context, { ...settings, googleTokens: tokens });
        instance.settings.googleTokens = tokens;
      } catch (err) {
        instance.settings.googleTokens = null;
        saveSettings(instance.context, { ...settings, googleTokens: null });
        return null;
      }
    }
const calendars = settings.calendars && settings.calendars.length ? settings.calendars : ['primary'];
    const meetings = [];
    for (const cal of calendars) {
      const evt = await fetchGoogleCalendar(cal, tokens.access_token);
      if (evt) meetings.push(evt);
    }
    if (!meetings.length) return null;
    const next = pickEarliest(meetings);
    next.provider = 'Google';
    return next;
  }

  async function ensureGoogleEmail(instance, tokens) {
    try {
      const info = await httpJson('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      if (info?.email) {
        const updated = { ...tokens, email: info.email };
        instance.settings.googleTokens = updated;
        return updated;
      }
    } catch (err) {
      log('userinfo failed', err);
    }
    return null;
  }

  async function fetchGoogleCalendar(calendarId, accessToken) {
    const params = new URLSearchParams({
      orderBy: 'startTime',
      singleEvents: 'true',
      timeMin: new Date().toISOString(),
      maxResults: '1'
    });
    let data;
    try {
      data = await httpJson(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
    } catch (err) {
      log('fetchGoogleCalendar error', calendarId, err?.message || err);
      return null;
    }
    if (!data.items || !data.items.length) return null;
    const ev = data.items[0];
    const start = ev.start?.dateTime || ev.start?.date;
    const end = ev.end?.dateTime || ev.end?.date || start;
    const joinUrl = ev.hangoutLink || extractJoinUrl(ev) || null;
    return {
      title: ev.summary || 'Meeting',
      provider: 'Google',
      start,
      end,
      joinUrl,
      status: determineStatus(start, end)
    };
  }

  function extractJoinUrl(ev) {
    const fields = [
      ev.hangoutLink,
      ev.location,
      ev.description
    ].filter(Boolean).join(' ');
    const match = fields.match(/https?:\/\/[^\s>"]+/);
    return match ? match[0] : null;
  }

  async function httpJson(url, options = {}) {
    if (typeof fetch === 'function') {
      const res = await fetch(url, options);
      if (res.status === 401) {
        log('httpJson unauthorized', url);
        throw new Error('unauthorized');
      }
      if (!res.ok) {
        const text = await res.text();
        log('httpJson error', url, res.status, text);
        throw new Error(`http ${res.status}`);
      }
      return res.json();
    }
    // Fallback for environments without fetch
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(options.method || 'GET', url);
      const headers = options.headers || {};
      Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      xhr.onload = () => {
        if (xhr.status === 401) return reject(new Error('unauthorized'));
        if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`http ${xhr.status}`));
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

  function pickEarliest(meetings) {
    const now = Date.now();
    const sorted = [...meetings].sort((a, b) => new Date(a.start) - new Date(b.start));
    const next = sorted.find((m) => new Date(m.end || m.start).getTime() >= now);
    if (!next) {
      return {
        title: 'No Events',
        provider: 'Google',
        start: null,
        end: null,
        joinUrl: null,
        status: 'free'
      };
    }
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
    const { context } = instance;
    const status = meeting.status || determineStatus(meeting.start, meeting.end);
    const lines = buildLines(meeting);
    const svg = buildSvgTile(lines.title, lines.subtitle, status, meeting.provider, meeting.joinUrl);
    setImage(context, svg);
    setTitle(context, '');
  }

  function renderError(instance, err) {
    const title = 'Error';
    const subtitle = err?.message ? err.message.slice(0, 24) : 'Check auth';
    const svg = buildSvgTile(title, subtitle, 'live', 'Google', false);
    setImage(instance.context, svg);
    setTitle(instance.context, `${title}\\n${subtitle}`);
  }

  function buildLines(meeting) {
    if (!meeting.start) {
      return { title: 'No Events', subtitle: 'All clear' };
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
      subtitle = `${minsLeft}m left`;
    } else if (status === 'imminent' || status === 'upcoming') {
      const mins = Math.max(0, Math.round((startTs - now) / 60000));
      subtitle = mins <= 1 ? 'now' : `in ${mins}m`;
    } else {
      subtitle = formatTime(start);
    }
    return { title: truncate(meeting.title || 'Meeting', 16), subtitle };
  }

  function formatTime(date) {
    const hours = date.getHours();
    const mins = `${date.getMinutes()}`.padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const hour12 = hours % 12 === 0 ? 12 : hours % 12;
    return `${hour12}:${mins} ${ampm}`;
  }

  function buildSvgTile(title, subtitle, status, provider, hasLink) {
    const bg = statusColors[status] || statusColors.free;
    const providerLabel = '📅';
    const badge = ''; // only calendar icon
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='144' height='144'>` +
      `<rect width='144' height='144' rx='16' ry='16' fill='${bg}'/>` +
      `<text x='12' y='32' font-family='Arial, sans-serif' font-size='18' fill='#FFFFFF' opacity='0.9'>${providerLabel}</text>` +
      `<text x='12' y='72' font-family='Arial, sans-serif' font-size='20' fill='#FFFFFF'>${escapeSvg(title)}</text>` +
      `<text x='12' y='104' font-family='Arial, sans-serif' font-size='18' fill='#FFFFFF' opacity='0.9'>${escapeSvg(subtitle)}</text>` +
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

  // Expose connect for Stream Deck
  window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;
})();

  function truncate(str, max) {
    if (!str) return '';
    return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
  }

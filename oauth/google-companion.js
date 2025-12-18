#!/usr/bin/env node
/**
 * Minimal OAuth companion for Google Calendar using PKCE.
 * Requires environment variables:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 * Optional:
 *   PORT (default 43123)
 *   REDIRECT_URI (default http://localhost:43123/callback)
 * Tokens are persisted to oauth_tokens.json in the same folder.
 */
const http = require('http');
const { randomBytes, createHash } = require('crypto');
const { URL } = require('url');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = Number(process.env.PORT || 43123);
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;
const TOKEN_PATH = path.join(__dirname, 'oauth_tokens.json');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars before running.');
  process.exit(1);
}

let pending = null; // { verifier, state }

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildAuthUrl() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const state = base64Url(randomBytes(16));
  pending = { verifier, state };
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar.readonly openid email profile');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

function openBrowser(url) {
  const platform = process.platform;
  if (platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true });
  else if (platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
  else spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
}

function decodeIdTokenEmail(idToken) {
  try {
    const payload = idToken.split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    const data = JSON.parse(json);
    return data.email || null;
  } catch (_) {
    return null;
  }
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8');
}

function readTokens() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to read tokens', err);
    return null;
  }
}

async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
    code_verifier: verifier
  }).toString();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error(`Token exchange failed ${res.status}`);
  return res.json();
}

async function fetchUserInfo(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return null;
  return res.json();
}

async function handler(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/start') {
    const authUrl = buildAuthUrl();
    openBrowser(authUrl);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, authUrl }));
    return;
  }
  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || !pending || state !== pending.state) {
      res.writeHead(400); res.end('Invalid state or missing code');
      return;
    }
    try {
      const tokenData = await exchangeCode(code, pending.verifier);
      const now = Math.floor(Date.now() / 1000);
      let email = decodeIdTokenEmail(tokenData.id_token || '');
      if (!email) {
        const info = await fetchUserInfo(tokenData.access_token);
        email = info?.email || null;
      }
      const tokens = {
        provider: 'Google',
        email,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        client_id: CLIENT_ID,
        expires_at: now + (tokenData.expires_in || 0),
        scope: tokenData.scope
      };
      saveTokens(tokens);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Auth complete. You can close this window.</body></html>');
    } catch (err) {
      res.writeHead(500); res.end(`Error: ${err.message}`);
    } finally {
      pending = null;
    }
    return;
  }
  if (url.pathname === '/tokens') {
    const tokens = readTokens();
    if (!tokens) { res.writeHead(404); res.end('No tokens'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tokens));
    return;
  }
  res.writeHead(404); res.end('Not found');
}

http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    console.error(err);
    res.writeHead(500); res.end('Server error');
  });
}).listen(PORT, () => {
  console.log(`OAuth companion running on http://localhost:${PORT}`);
  console.log('GET /start to begin OAuth');
});

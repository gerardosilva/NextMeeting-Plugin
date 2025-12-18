export default async function handler(req, res) {
  const { code, state } = req.query;
  if (!code || !state) {
    res.status(400).send('Missing code/state');
    return;
  }
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/google/callback`;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    res.status(500).send('Missing server env GOOGLE_CLIENT_ID/SECRET');
    return;
  }
  let verifier;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
    verifier = decoded.verifier;
  } catch (err) {
    res.status(400).send('Invalid state');
    return;
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        code_verifier: verifier
      }).toString()
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new Error(`Token exchange failed ${tokenRes.status}: ${text}`);
    }
    const tokenData = await tokenRes.json();
    let email = null;
    try {
      const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      if (infoRes.ok) {
        const info = await infoRes.json();
        email = info.email || null;
      }
    } catch (_) {
      // ignore
    }
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      provider: 'Google',
      email,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: now + (tokenData.expires_in || 0),
      scope: tokenData.scope,
      client_id: CLIENT_ID
    };
    const html = `
<!doctype html>
<html><body>
<script>
  (function() {
    const data = ${JSON.stringify(payload)};
    if (window.opener) {
      window.opener.postMessage({ type: 'googleTokens', data }, '*');
      window.close();
    } else {
      document.body.innerText = 'Auth complete. You can close this window.';
    }
  })();
</script>
</body></html>`;
    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
}

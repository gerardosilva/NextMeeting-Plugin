## Stream Deck Next Meeting Plugin Template

Shows your next Google Calendar event and lets you join with one press. Uses OAuth PKCE with a separate backend for token exchange and refresh.

### What’s included
- Stream Deck plugin manifest with one `next.meeting` action.
- Plugin runtime (`src/plugin.js`) that handles updates, status display, and click-to-refresh.
- Property Inspector UI (`src/property_inspector.html` + `src/property-inspector.js`) with Google connect.
- Minimal theming assets in `assets/`.

### Behavior
- Auto-updates every 10s.
- Tap the key to force refresh (and open the meeting link if available).
- Shows a red error state with an `!` icon when there is a connection failure.
- Shows a red "Reconnect / Auth expired" state when OAuth tokens are invalid.

### OAuth flow
This plugin expects a separate OAuth backend to exchange the auth code and refresh tokens:
- `/api/google/callback` exchanges the code for tokens.
- `/api/google/refresh` refreshes access tokens using the `refresh_token`.

### Configure OAuth for production
Update these constants in `src/property-inspector.js`:
- `VERCEL_OAUTH_BASE` to your backend domain (for example `https://your-project.vercel.app`)
- `GOOGLE_CLIENT_ID` to your OAuth client ID

### Packaging
Use the Elgato CLI to create the `.streamDeckPlugin` file:
```
npx @elgato/cli pack com.elgato.nextmeeting.sdPlugin -o . -f
```

### Repository structure
```
assets/
  icon.png
  actionIcon.png
manifest.json
src/
  plugin.js
  property_inspector.html
  property-inspector.js
```

### Notes
- This repo targets Google Calendar only.
- Client secrets are not stored in the plugin; they belong in the separate backend project.
- This repo is intended to stay plugin-only. Keep OAuth callback/refresh endpoints in a separate repository.

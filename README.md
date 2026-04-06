## Stream Deck Next Meeting Plugin

This Stream Deck plugin shows your next calendar event and lets you join it with one tap. The current implementation supports multiple Google and Outlook accounts, with OAuth token refresh through a small Vercel backend.

### What’s included
- Stream Deck plugin manifest with one `next.meeting` action.
- Plugin runtime (`src/plugin.js`) that handles connection, settings, throttled updates, and state display.
- Property Inspector UI (`src/property_inspector.html` + `src/property-inspector.js`) to pick provider, account, calendars, and mock data for local testing.
- Minimal theming assets in `assets/`.
- Implementation guide for OAuth 2.0, Google Calendar, and Microsoft Graph.

### Quick start
1. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` locally or in your Vercel project.
2. Deploy the `api/google/*` endpoints, or run the local companion from `oauth/google-companion.js`.
3. Place this folder as `com.elgato.nextmeeting.sdPlugin` in the Stream Deck plugins directory or package it with Elgato's Distribution Tool.
4. Use `Reload Plugins` in Stream Deck to pick up changes.

### OAuth and providers
- **OAuth**: The property inspector uses OAuth 2.0 PKCE. Client secrets stay server-side in the Vercel callbacks.
- **Google refresh**: `POST /api/google/refresh` refreshes expired access tokens. If Google does not reissue a `refresh_token`, the previous one is preserved.
- **Microsoft refresh**: `POST /api/microsoft/refresh` refreshes Microsoft Graph tokens for Outlook accounts.
- **Reconnect behavior**: Transient refresh/network failures keep the saved accounts. The plugin only asks to reconnect when the provider rejects the refresh token.
- **Google Calendar**: Uses Calendar v3 `events.list` with `orderBy=startTime`, `singleEvents=true`, `timeMin=now`, and `maxResults=1`.
- **Microsoft Outlook/Graph**: Uses Microsoft Graph `calendarView` for the default or selected calendar, and parses Teams/meeting links from `onlineMeeting`, `onlineMeetingUrl`, locations, or event body preview.
- **Multiple accounts**: Settings now store an array of accounts, and the plugin picks the earliest upcoming meeting across all enabled Google and Outlook accounts.
- **Status display**: Colors and text states are defined in `src/plugin.js`. Update icons/text based on time-to-start and meeting status.

### Feature mapping
- Multi-provider, multi-account: settings store an array of providers/calendars.
- Real-time countdown: plugin updates every 15s by default and renders `in Xm`, `now`, or `Xm left`.
- One-click join: primary tap opens the meeting URL if available.
- Smart visuals: background/titles change by status (free, upcoming, live, ending).
- Dynamic emojis/logos: text badges use provider + meeting type emoji hints.
- Secure OAuth: placeholders documented; no secrets stored in code.
- Performance: debounced renders and caching hooks ready for API responses.

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

### Next steps
- Add a proper build/release step so `src/` and `com.elgato.nextmeeting.sdPlugin/` are generated from one source of truth.
- Improve account management with provider-specific calendar pickers instead of manual IDs.
- Add richer provider-specific iconography and meeting source badges.

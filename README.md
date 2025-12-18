## Stream Deck Next Meeting Plugin (Scaffold)

This is a starting point for a Stream Deck plugin that shows your next calendar event and lets you join it with one tap. The code is intentionally lightweight and ready for OAuth integrations (Google/Outlook) plus multiple accounts.

### What’s included
- Stream Deck plugin manifest with one `next.meeting` action.
- Plugin runtime (`src/plugin.js`) that handles connection, settings, throttled updates, and state display.
- Property Inspector UI (`src/property_inspector.html` + `src/property-inspector.js`) to pick provider, account, calendars, and mock data for local testing.
- Minimal theming assets in `assets/`.
- Implementation guide for OAuth 2.0, Google Calendar, and Microsoft Graph.

### Quick start (dev/test)
1) Install the Elgato Distribution Tool and place this folder as `com.elgato.nextmeeting.sdPlugin` in the Stream Deck plugins directory or zip it via the tool.  
2) Open the property inspector on a key; choose `Mock Data` to see live updates without a backend.  
3) Use `Reload Plugins` in Stream Deck to pick up changes.

### Implementing real calendar access
- **OAuth**: Use OAuth 2.0 PKCE. Recommended approach: open the provider’s auth page from the Property Inspector, run a tiny localhost redirect listener (Electron/Node) or use a companion app to exchange the code for tokens, then store refresh tokens in the plugin’s settings (encrypted if possible). Avoid embedding client secrets in the plugin.
- **Google Calendar**: Use the Calendar v3 `events.list` endpoint with `orderBy=startTime`, `singleEvents=true`, `timeMin=now`, `maxResults=1`, and `calendarIds` from user settings. Cache responses and respect `etag`/`syncToken`.
- **Microsoft Outlook/Graph**: Use `/me/events?$filter=start/dateTime ge {now}` with `orderBy=start/dateTime` and `top=1`. Support both Work/School (Azure AD) and Personal (MSA) by configuring the correct tenant and endpoints.
- **Meeting links**: Parse `onlineMeeting`, `location`, and `bodyPreview` for Teams/Zoom/Meet/Webex URLs. Prefer provider-specific fields (e.g., `onlineMeeting.joinUrl` on Graph) before falling back to regex extraction.
- **Multiple accounts**: Persist an array of account configs in settings; the plugin picks the earliest meeting across enabled calendars.
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
- Wire real OAuth flows (PKCE) and token storage.
- Implement Google/Graph fetchers and meeting-link detection.
- Add localization and richer iconography per status.
- Package with the Distribution Tool for installation.

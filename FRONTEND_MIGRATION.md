# Frontend Integration Guide — Medical Scribe Assistant

This guide explains how to migrate and plug the Medical Scribe Assistant UI into your personal portfolio frontend. The UI is a lightweight, dependency‑free web client built with vanilla HTML/CSS/JS under `web/`.

## What You’re Integrating
- `web/index.html` — page UI with controls and settings
- `web/styles.css` — minimal styling
- `web/main.js` — recording, diarization upload, and summarization flows
- `web/sw.js` — optional offline cache
- `web/manifest.webmanifest` — optional installable manifest

Key client hooks:
- Config storage defaults at `web/main.js:26`
- ASR setup at `web/main.js:141`
- Audio chunked upload at `web/main.js:87`
- Summarization flow at `web/main.js:217`

## Integration Options

### Option A — Standalone Page in Your App
Use the existing HTML/JS as a routed page.

1. Create a route (e.g., `/scribe`) that serves `index.html` and static assets.
2. Copy files into your frontend’s public/static folder:
   - `web/index.html`, `web/styles.css`, `web/main.js`, `web/sw.js`, `web/manifest.webmanifest`
3. Ensure `index.html` references are correct for your static path. The client expects:
   ```html
   <link rel="stylesheet" href="./styles.css" />
   <script src="./main.js" type="module"></script>
   ```
4. If your framework requires asset hashing or bundling, mark `main.js` as an ES module and configure it as an external file rather than bundling into the app runtime.
5. Expose a settings UI or preconfigure the API base URL (see “API Configuration”).

Framework notes:
- React/Vite: Place assets under `public/` and add a route that renders the HTML via `index.html` or an iframe pointed at `/scribe/index.html`.
- Next.js: Put files under `public/scribe/` and create a page that redirects or iframes `/scribe/index.html`.
- Static sites: Serve the files as a subfolder under your host.

### Option B — Embed as a Widget Component
If you prefer integration inside existing React/Next pages:

- Render a container page and include the script tag for `main.js` as a module. The script manages its own DOM elements defined in `index.html`.
- Alternatively, lift smaller pieces (buttons/textarea) into your component and port event wiring from:
  - UI bindings at `web/main.js:339`
  - Recording lifecycle at `web/main.js:155` and `web/main.js:202`
  - Summarization call at `web/main.js:257` → backend `/summarize` `server/server.mjs:201`

This path requires replicating the DOM structure from `index.html` and keeping IDs consistent with `web/main.js` selectors at `web/main.js:1`.

## API Configuration
The UI calls your backend at `config.apiBase`:
- Default config is loaded at `web/main.js:26`.
- Users can set the API base via the Settings dialog in the page (`web/index.html:...` inputs are wired by `web/main.js:37`).

To hard‑wire a default for your portfolio domain, change the default:
```js
// web/main.js:26
let config = storage.get(cfgKey, { apiBase: 'https://your-domain.example/api/scribe', lang: 'en-US' });
```

## Permissions & HTTPS
- Microphone access requires secure context (HTTPS) or `http://localhost` for development.
- ASR is via Web Speech API setup at `web/main.js:141`; support varies by browser (Chrome/Edge recommended).

## CORS / Proxy
If your portfolio frontend is on a different origin than the scribe backend:
- Configure a dev proxy in your frontend (e.g., Vite/Next) to forward `/scribe-api` → backend `http://localhost:8787`.
- Or keep `config.apiBase` pointed directly to the backend and enable CORS in the backend (already enabled in `server/server.mjs:18`).

## Optional PWA Enhancements
- Service worker registration occurs in `web/index.html:...` and caches core assets via `web/sw.js:1`.
- Include `web/manifest.webmanifest` in your public path for installability.

## Validation Checklist
- Route serves `index.html` and assets without 404s.
- Microphone prompts appear; status updates reflect ASR events.
- Clicking “Summarize” sends requests to your backend and renders the note.
- “Download .md” and “Copy” actions work.

## Backend Endpoints (for reference)
- Upload init `POST /upload_init` (`server/server.mjs:131`) → `{ uploadId }`
- Upload chunk `POST /upload_chunk?uploadId=...&index=...` (`server/server.mjs:142`) → `{ ok, index }`
- Upload finalize `POST /upload_finalize` (`server/server.mjs:162`) → `{ fileId }`
- Attribute speakers `POST /attribute` (`server/server.mjs:187`) → `{ dialogue, provider }`
- Summarize `POST /summarize` (`server/server.mjs:201`) → `{ note, provider }`

## Quick Dev Serve (optional)
You can serve the UI directly with PowerShell for local testing:
- `serve.ps1` static server (`serve.ps1:1`) → `powershell -ExecutionPolicy Bypass -File .\serve.ps1 -Port 5500 -Root .\web`


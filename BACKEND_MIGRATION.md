# Backend Integration Guide — Medical Scribe Assistant

This guide shows how to plug the Medical Scribe Assistant API into your portfolio backend. The server is a minimal Node HTTP service with no external dependencies located at `server/server.mjs`.

## Capabilities
- Chunked audio upload (`/upload_init`, `/upload_chunk`, `/upload_finalize`)
- Speaker attribution (`/attribute`) via Together AI Qwen or local adapters
- SOAP summarization (`/summarize`) via Together AI Qwen or local adapters
- Built‑in CORS (`server/server.mjs:18`) and `.env` loader (`server/server.mjs:9`)

## Option A — Run as a Sidecar Microservice
Keep the scribe API separate and route requests from your portfolio.

1. Copy `server/` into your portfolio repo, e.g., `services/scribe/`.
2. Create `services/scribe/.env` from `server/env.example`:
   ```env
   PORT=8787
   TOGETHER_API_KEY=your_together_key
   MODEL=qwen2.5-3b-instruct
   # Optional local adapters
   # LOCAL_QWEN_URL=http://127.0.0.1:5001
   # LOCAL_QWEN_CMD=python server/local_qwen_cli.py
   ```
3. Add a start script: `node server.mjs`.
4. Expose the service internally (e.g., reverse proxy `/scribe-api/*` → `http://localhost:8787`).
5. Point the frontend to the proxy path or direct URL (see frontend guide).

Pros
- Isolation; no dependency collision with your existing backend.
- Easy to scale or run offline when `TOGETHER_API_KEY` isn’t set (uses heuristics).

## Option B — Merge Endpoints into Your Existing Node/Express Server
Wrap the handlers from `server/server.mjs` inside your framework.

1. Environment
   - Load `.env` values similar to `server/server.mjs:9`.
   - Ensure `fetch` is available (Node 18+ or bring a polyfill).

2. CORS
   - Mirror headers from `server/server.mjs:18` or use your CORS middleware.

3. Routes
Port the logic per route. Signatures and payloads:

- `POST /upload_init` (`server/server.mjs:131`)
  - Response: `{ uploadId }`

- `POST /upload_chunk?uploadId=...&index=...` (`server/server.mjs:142`)
  - Body: raw binary
  - Response: `{ ok, index }`

- `POST /upload_finalize` (`server/server.mjs:162`)
  - JSON: `{ uploadId, filename? }`
  - Response: `{ fileId }`

- `POST /attribute` (`server/server.mjs:187`)
  - JSON: `{ segments: [{ ts, text }...], audioBase64?, audioFileId? }`
  - Response: `{ dialogue, provider }`

- `POST /summarize` (`server/server.mjs:201`)
  - JSON: `{ transcript, segments?, audioFileId? }`
  - Response: `{ note, provider }`

Implementation notes:
- Audio temp path root: `join(tmpdir(), 'msa_uploads')` (`server/server.mjs:123`). Keep identical for compatibility with the frontend’s `uploadAudio()` flow (`web/main.js:87`).
- Attribution uses `attributeWithTogether()` (`server/server.mjs:236`) and may prefer local adapters when `LOCAL_QWEN_URL`/`LOCAL_QWEN_CMD` are set.
- Summarization uses `summarizeWithTogether()` (`server/server.mjs:41`) with an offline fallback when no key is present.

### Express Skeleton Example
Below is a minimal outline showing how you can adapt the chunked upload and summarize endpoints. Retain file system paths and JSON shapes.

```js
import express from 'express';
import cors from 'cors';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, appendFileSync } from 'node:fs';

const app = express();
app.use(cors());
app.use(express.json());

app.post('/upload_init', (req, res) => {
  const id = crypto.randomBytes(12).toString('hex');
  const dir = join(tmpdir(), 'msa_uploads', `upload_${id}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  res.json({ uploadId: id });
});

app.post('/upload_chunk', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
  const { uploadId, index } = req.query;
  if (!uploadId || index === undefined) return res.status(400).json({ error: 'Missing uploadId or index' });
  const dir = join(tmpdir(), 'msa_uploads', `upload_${uploadId}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const partPath = join(dir, `chunk_${String(index).padStart(6, '0')}`);
  writeFileSync(partPath, req.body);
  res.json({ ok: true, index });
});

app.post('/upload_finalize', (req, res) => {
  const { uploadId, filename } = req.body || {};
  if (!uploadId) return res.status(400).json({ error: 'Missing uploadId' });
  const dir = join(tmpdir(), 'msa_uploads', `upload_${uploadId}`);
  const parts = readdirSync(dir).filter(f => f.startsWith('chunk_')).sort();
  const outDir = join(tmpdir(), 'msa_uploads'); if (!existsSync(outDir)) mkdirSync(outDir, { recursive:true });
  const outName = filename ? `upload_${Date.now()}_${filename}` : `upload_${Date.now()}.webm`;
  const outPath = join(outDir, outName);
  for (const p of parts) appendFileSync(outPath, readFileSync(join(dir, p)));
  for (const p of parts) unlinkSync(join(dir, p));
  try { unlinkSync(dir); } catch {}
  res.json({ fileId: outPath });
});

// TODO: mount /attribute and /summarize by reusing the functions from server.mjs
app.listen(process.env.PORT || 8787);
```

For `/attribute` and `/summarize` you can import and reuse the helper functions from `server/server.mjs` or move them into a shared module.

## Environment Variables
- `PORT` — default `8787` (`server/server.mjs:14`)
- `TOGETHER_API_KEY` — Together AI key for Qwen
- `MODEL` — e.g., `qwen2.5-3b-instruct` (`server/server.mjs:16`)
- Optional local adapters:
  - `LOCAL_QWEN_URL` — HTTP adapter for attribution/summarization (`server/server.mjs:74`, `server/server.mjs:241`)
  - `LOCAL_QWEN_CMD` — CLI adapter (`server/server.mjs:89`, `server/server.mjs:344`)

## Sample Calls
- Upload (chunked):
  - Init: `curl -X POST http://localhost:8787/upload_init`
  - Chunk: `curl --data-binary @chunk.bin "http://localhost:8787/upload_chunk?uploadId=XYZ&index=0"`
  - Finalize: `curl -X POST -H "Content-Type: application/json" -d '{"uploadId":"XYZ","filename":"session.webm"}' http://localhost:8787/upload_finalize`

- Attribute:
  ```bash
  curl -X POST -H "Content-Type: application/json" \
       -d '{"segments":[{"ts":1,"text":"Hi Doctor"},{"ts":2,"text":"How can I help?"}]}' \
       http://localhost:8787/attribute
  ```

- Summarize:
  ```bash
  curl -X POST -H "Content-Type: application/json" \
       -d '{"transcript":"[Clinician] How can I help?\n[Patient] I have a cough."}' \
       http://localhost:8787/summarize
  ```

## Security Notes
- Do not expose `TOGETHER_API_KEY` in the frontend. Keys are only read server‑side (`server/server.mjs:9`).
- Keep CORS restricted in production by replacing `'*'` with your portfolio origin.
- Uploaded audio is stored under the OS temp directory (`server/server.mjs:123`). Periodically clean if needed.

## Validation Checklist
- Service starts and logs: `Medical Scribe Assistant API listening on http://localhost:8787` (`server/server.mjs:223`).
- `/attribute` responds and updates the frontend transcript.
- `/summarize` returns a SOAP note.
- Audio chunk upload succeeds and returns a `fileId`.


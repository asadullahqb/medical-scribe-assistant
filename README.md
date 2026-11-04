# Medical Scribe Assistant – POC (Free-tier, lightweight models)

This POC demonstrates an ambient AI scribe that records speech on mobile, transcribes in the browser for free, and generates a SOAP-style clinical note using a free-tier Qwen model via Together AI (or any future provider you configure).

Key choices for a $0 POC:
- Transcription: Browser Web Speech API (Chrome/Edge) – no keys, no charges.
- LLM: Together AI `qwen2.5-3b-instruct` (free community tier; configurable).
- Privacy: Audio never leaves device for transcription; only text transcript is sent to the LLM when you press Summarize.

## Quick start

1) Serve the `web/` folder over HTTP (browsers block module scripts from file://):
   - Windows PowerShell (no installs):
     ```bash
     powershell -ExecutionPolicy Bypass -File .\serve.ps1 -Port 5500 -Root .\web
     ```
     Then open `http://localhost:5500` in Chrome/Edge.
   - Or, if you have Python: `py -m http.server 5500 -d web`
2) To enable clinical note generation with Qwen:
   - Install Node.js LTS (18+). Re-open your terminal so `node` is on PATH.
   - In this folder, create a `.env` from `.env.example` and set `TOGETHER_API_KEY`.
   - Run the server:
     ```bash
     node server/server.mjs
     ```
   - In the web app, set the API URL to `http://localhost:8787` (gear icon) and click Summarize.

## Project structure
- `web/` – PWA web app (mobile friendly). Uses Web Speech API for live captions, session autosave, export/copy.
- `server/server.mjs` – Minimal Node HTTP server (no deps) proxying to Together AI Qwen and applying the SOAP prompt.
- `.env.example` – Example environment variables.

## Notes
- Accuracy of browser speech recognition varies; for production use, swap in Whisper or another medical ASR.
- You can switch away from Together AI by editing the provider section in `server/server.mjs`.

## Local Qwen integration (optional)
If you'd like attribution to run on a local Qwen model (instead of Together AI), the server supports two adapters:


Set one of these environment variables in your `.env` to enable local attribution. When present, the server will prefer the local adapter for the `/attribute` endpoint. If neither is present and `TOGETHER_API_KEY` is unset, a conservative offline heuristic is used.

Local summarization
The same adapters can be used to run summarization (the `/summarize` endpoint) locally:
- If `LOCAL_QWEN_CMD` is set, the server will run that shell command and pass `{ transcript }` JSON on stdin; the command should print either JSON with `{ note }` or plain text for the note.


Local diarization adapter (example)
-----------------------------------
I've included a minimal example local adapter using `resemblyzer` in `server/local_adapter.py`. It provides an HTTP endpoint at `/attribute` that accepts JSON `{ segments, audioBase64 }` and returns `{ dialogue, clusters, diar }` where `dialogue` contains cluster-labeled lines (e.g., `[Speaker 0] ...`).

Quick setup (Windows / PowerShell):

1) Create and activate a virtual environment in the `server/` folder:

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -U pip
```

2) Install dependencies (note: install a matching PyTorch wheel for Windows first if needed):

```powershell
# Example (CPU-only) - adjust per PyTorch instructions
pip install flask numpy scipy sklearn librosa soundfile resemblyzer torch
```

3) Run the adapter:

```powershell
python local_adapter.py
```

This starts the adapter on `http://127.0.0.1:5001`. In your main app `.env` set:

```text
LOCAL_QWEN_URL=http://127.0.0.1:5001
```

4) Use the web UI: record a session and click Summarize — the client will send audio (base64) and segments to the server which will forward them to the local adapter for diarization.

Notes:
- The example uses sliding-window embeddings and simple agglomerative clustering (k=2). It's intended as a starting point and can be swapped with `pyannote` for higher accuracy.
- After the adapter returns cluster-labeled dialogue, we can call your local Qwen model to map clusters -> roles (Clinician/Patient) and to produce the final SOAP note. I can add that step next — tell me how you run Qwen locally (CLI or an HTTP wrapper) and I will wire it in.
 
Chunked uploads for long sessions
--------------------------------
For long recordings (30–60 minutes) the client uploads audio using a chunked/resumable flow to avoid large base64 payloads. The steps are:

1. Client POST /upload_init -> receives uploadId
2. Client POST /upload_chunk?uploadId=...&index=... for each chunk (binary body)
3. Client POST /upload_finalize { uploadId, filename } -> server concatenates parts into a single file and returns { fileId }

The client then calls POST /attribute with { segments, audioFileId } where audioFileId is the server-side path returned by /upload_finalize. The server forwards the path to the local adapter which reads the file directly.

This flow is implemented in the web client and the server to support large sessions reliably.
When either local adapter is configured the server will prefer it for both attribution and summarization. If none is present and `TOGETHER_API_KEY` is not set, the server falls back to a conservative rule-based heuristic for attribution and a simple fallback summarizer.

## Security
- The browser only sends plain text transcript to your server when summarizing; do not expose API keys in the client.

## License
For POC/demo purposes only; no warranties.



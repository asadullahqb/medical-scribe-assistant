const els = {
  start: document.getElementById('startBtn'),
  stop: document.getElementById('stopBtn'),
  summarize: document.getElementById('summarizeBtn'),
  clear: document.getElementById('clearBtn'),
  copy: document.getElementById('copyBtn'),
  download: document.getElementById('downloadBtn'),
  transcript: document.getElementById('transcript'),
  note: document.getElementById('note'),
  status: document.getElementById('status'),
  settingsBtn: document.getElementById('settingsBtn'),
  dialog: document.getElementById('settingsDialog'),
  apiUrl: document.getElementById('apiUrl'),
  lang: document.getElementById('lang'),
  saveSettings: document.getElementById('saveSettings'),
  segment: document.getElementById('segmentBtn'),
};

const storage = {
  get(key, fallback){try{return JSON.parse(localStorage.getItem(key)) ?? fallback}catch{return fallback}},
  set(key, value){localStorage.setItem(key, JSON.stringify(value))},
};

const cfgKey = 'msa_config_v1';
const sessionKey = 'msa_transcript_v1';
let config = storage.get(cfgKey, { apiBase: '', lang: 'en-US' });
let recognition;
let isRecording = false;
let dialogueTurns = []; // [{speaker, text}]
let segments = []; // [{ts, text}]
let lastFinalTs = 0;
let mediaRecorder;
let recordedChunks = [];
let sessionAudioBlob = null;
let sessionAudioFileId = null;

function initSettingsUI(){
  els.apiUrl.value = config.apiBase;
  els.lang.value = config.lang;
}

function saveSettings(){
  config = { apiBase: els.apiUrl.value.trim(), lang: els.lang.value.trim() || 'en-US' };
  storage.set(cfgKey, config);
}

function setStatus(text){
  els.status.textContent = text;
}

function restoreTranscript(){
  const t = storage.get(sessionKey, '');
  if (!t) return;
  // Restore the raw textarea then reconstruct segments/dialogueTurns
  els.transcript.value = t;
  dialogueTurns = [];
  segments = [];
  // If the saved transcript already contains speaker tags, parse them back into dialogueTurns
  if (/\[Clinician\]|\[Patient\]/.test(String(t))){
    String(t).split(/\r?\n/).forEach(line=>{
      const m = /^\s*\[(Clinician|Patient)\]\s*(.*)$/.exec(line);
      if (m) dialogueTurns.push({ speaker: m[1], text: m[2] });
    });
  } else {
    // Otherwise split into sentence-like utterances and restore as segments (numbered)
    const parts = splitIntoUtterances(String(t));
    segments = parts.map(s=>({ ts: Date.now(), text: s.trim() }));
  }
  renderTranscript();
}

function autosave(){
  storage.set(sessionKey, els.transcript.value);
}

function forceSegment(){
  const t = els.transcript.value.trim();
  if (!t){ setStatus('Nothing to segment'); return; }
  const parts = splitIntoUtterances(t);
  segments = parts.map(s=>({ ts: Date.now(), text: s }));
  dialogueTurns = [];
  renderTranscript();
  autosave();
  setStatus(`Segmented into ${segments.length} utterance${segments.length===1?'':'s'}`);
}

async function uploadAudio(blob){
  if (!blob) return null;
  const base = (config.apiBase || '');
  // Chunked upload flow
  try{
    // Init
    const initRes = await fetch(base + '/upload_init', { method: 'POST' });
    if (!initRes.ok) throw new Error('upload_init failed');
    const { uploadId } = await initRes.json();
    const chunkSize = 5 * 1024 * 1024; // 5MB
    const total = Math.ceil(blob.size / chunkSize);
    for (let i=0;i<total;i++){
      const start = i*chunkSize; const end = Math.min(blob.size, start+chunkSize);
      const chunk = blob.slice(start, end);
      // Retry logic
      let attempts = 0; let ok = false;
      while(attempts < 3 && !ok){
        attempts++;
        const url = `${base}/upload_chunk?uploadId=${uploadId}&index=${i}`;
        try{
          const res = await fetch(url, { method: 'POST', body: chunk });
          if (!res.ok) throw new Error('chunk upload failed ' + res.status);
          ok = true;
        }catch(e){ console.warn('chunk upload attempt', attempts, e); await new Promise(r=>setTimeout(r, 500*(attempts))); }
      }
      if (!ok) throw new Error('Failed uploading chunk ' + i);
    }
    // Finalize
    const finalizeRes = await fetch(base + '/upload_finalize', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ uploadId, filename: 'session.webm' }) });
    if (!finalizeRes.ok) throw new Error('finalize failed');
    return await finalizeRes.json();
  }catch(e){ console.error('uploadAudio error', e); throw e; }
}

function splitIntoUtterances(text){
  if (!text) return [];
  // Match sequences that end with sentence punctuation, or the trailing fragment
  const parts = String(text).match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  return parts.map(p=>p.trim()).filter(Boolean);
}

function renderTranscript(){
  // If we have dialogueTurns with speakers, show them in the transcript area
  if (Array.isArray(dialogueTurns) && dialogueTurns.length){
    els.transcript.value = dialogueTurns.map(t=>`[${t.speaker}] ${t.text}`).join('\n');
    return;
  }
  // Otherwise, show numbered utterances from segments
  if (Array.isArray(segments) && segments.length){
    els.transcript.value = segments.map((s,i)=>`${i+1}: ${s.text}`).join('\n');
    return;
  }
}

function ensureASR(){
  const w = window;
  const ASR = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!ASR){
    alert('Web Speech API not supported in this browser. Use Chrome or Edge.');
    return null;
  }
  const r = new ASR();
  r.lang = config.lang || 'en-US';
  r.interimResults = true;
  r.continuous = true;
  return r;
}

function start(){
  if (isRecording) return;
  recognition = ensureASR();
  if (!recognition) return;
  // Start recording audio for post-session diarization
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia){
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream=>{
      try{
        mediaRecorder = new MediaRecorder(stream);
        recordedChunks = [];
        mediaRecorder.ondataavailable = (e)=>{ if (e.data && e.data.size) recordedChunks.push(e.data); };
        mediaRecorder.start();
      }catch(e){ console.warn('MediaRecorder start failed', e); }
    }).catch(e=> console.warn('getUserMedia failed', e));
  }
  dialogueTurns = [];
  segments = [];
  let liveBuffer = '';
  recognition.onresult = (e)=>{
    let finalText = '';
    for (let i=e.resultIndex;i<e.results.length;i++){
      const res = e.results[i];
      if (res.isFinal){ finalText += res[0].transcript + ' '; }
      else { liveBuffer = res[0].transcript; }
    }
    if (finalText) handleFinalUtterance(finalText.trim());
    if (liveBuffer) {
      setStatus('Listening… ' + liveBuffer.slice(0, 60));
    } else {
      setStatus('Listening…');
    }
    autosave();
  };
  recognition.onerror = (e)=> setStatus('ASR error: ' + e.error);
  recognition.onend = ()=>{
    isRecording = false;
    els.start.disabled = false;
    els.stop.disabled = true;
    setStatus('Stopped');
  };
  recognition.start();
  isRecording = true;
  els.start.disabled = true;
  els.stop.disabled = false;
  setStatus('Listening…');
}

function stop(){
  if (!isRecording || !recognition) return;
  recognition.stop();
  // Stop audio recording and generate blob
  try{
    if (mediaRecorder && mediaRecorder.state !== 'inactive'){
      mediaRecorder.stop();
      mediaRecorder.onstop = ()=>{
        sessionAudioBlob = new Blob(recordedChunks, { type: 'audio/webm' });
        // Optionally, we could convert to WAV on client; we'll send webm to server which can decode it
      };
    }
  }catch(e){ console.warn('Error stopping recorder', e); }
}

async function summarize(){
  let text = els.transcript.value.trim();
  if (!text){ alert('Nothing to summarize.'); return; }
  // Offline fallback: simple heuristic SOAP if no server configured
  if (!config.apiBase){
    els.note.value = heuristicSOAP(text);
    return;
  }
  setStatus('Summarizing with Qwen…');
  try{
    // Step 1: Ask server to attribute speakers using AI (uses segments with timestamps)
    let attributed = text;
    try {
      const buildFromTranscript = (t)=>{
        // Split into sentence-like chunks as pseudo-utterances
        return String(t).split(/(?<=[.!?])\s+/).filter(Boolean).map(s=>({ ts: Date.now(), text: s.trim() })).slice(0, 200);
      };
      const attrSegments = (Array.isArray(segments) && segments.length) ? segments : buildFromTranscript(text);
      // If we recorded audio this session, send it as base64 to /attribute for diarization
      const payload = { segments: attrSegments };
      if (sessionAudioBlob){
            // For long sessions, upload the audio as a file instead of encoding to base64
            try{
              const uploadRes = await uploadAudio(sessionAudioBlob);
          if (uploadRes?.fileId){ payload.audioFileId = uploadRes.fileId; sessionAudioFileId = uploadRes.fileId; }
            }catch(e){ console.warn('Audio upload failed', e); }
      }
      const attrRes = await fetch(config.apiBase + '/attribute',{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      if (attrRes.ok){
        const attr = await attrRes.json();
        if (attr?.dialogue) {
          attributed = String(attr.dialogue);
          els.transcript.value = attributed; // show user the labeled dialogue
        }
      }
    } catch {}

    // Step 2: Summarize using attributed text
    const res = await fetch(config.apiBase + '/summarize',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ transcript: attributed, segments, audioFileId: sessionAudioFileId })
    });
    if(!res.ok) throw new Error(await res.text());
    const data = await res.json();
    els.note.value = data.note || '';
  }catch(err){
    console.error(err);
    alert('Summarization failed. Falling back to offline heuristic.');
    els.note.value = heuristicSOAP(text);
  }finally{
    setStatus('Idle');
  }
}

function heuristicSOAP(text){
  const lower = text.toLowerCase();
  const subjective = text;
  const objective = 'Vitals and exam findings as observed during the visit.';
  const assessment = 'Working diagnosis based on history and exam.';
  const plan = '1) Continue current meds as appropriate. 2) Follow-up as needed.';
  // Very naive keyword nudges
  const dx = lower.includes('cough') ? 'Acute cough' : lower.includes('pain') ? 'Pain, unspecified' : 'Assessment pending';
  return `# Subjective\n${subjective}\n\n# Objective\n${objective}\n\n# Assessment\n${dx}. ${assessment}\n\n# Plan\n${plan}`;
}

function attributeSpeaker(utterance){
  const t = utterance.toLowerCase();
  let patientScore = 0, clinicianScore = 0;
  // Patient-like cues
  if (/(^|\s)(i |i'm |my |mine |me |i’ve |i have)/.test(t)) patientScore+=1.6;
  if (/(hurts|pain|since|started|feels|feel|ache|cough|fever|dizzy|nausea|certificate|note for work)/.test(t)) patientScore+=1.2;
  if (/\b(doctor|doc)\b/.test(t)) patientScore+=0.6; // addressing clinician
  if (/\b(yes|no|uh huh|um)\b/.test(t)) patientScore+=0.5;
  // Clinician-like cues
  if (/(let's|we will|i recommend|i'll prescribe|start you on|examine|blood pressure|pulse|follow up|take|order|schedule|provide you with)/.test(t)) clinicianScore+=2;
  if (/(how long|when did|do you have|are you taking|any allergies|could you tell me)/.test(t)) clinicianScore+=1.5;
  if (/\?$/.test(t)) clinicianScore+=0.6; // questions lean clinician
  return clinicianScore >= patientScore ? 'Clinician' : 'Patient';
}

function appendDialogue(speaker, text){
  dialogueTurns.push({ speaker, text });
  // Keep the main transcript mirrored with attribution
  renderTranscript();
}

function handleFinalUtterance(text){
  const now = Date.now();
  const turnGapMs = 1200; // treat pauses >1.2s as likely turn boundaries
  let speaker = attributeSpeaker(text);
  // Save raw segment for server-side AI attribution (with timestamp)
  segments.push({ ts: now, text });
  if (dialogueTurns.length > 0 && now - lastFinalTs < turnGapMs){
    // Same turn if very close in time and same speaker guess
    const prev = dialogueTurns[dialogueTurns.length - 1];
    if (prev.speaker === speaker){
      prev.text += ' ' + text;
      renderTranscript();
    } else {
      appendDialogue(speaker, text);
    }
  } else {
    appendDialogue(speaker, text);
  }
  lastFinalTs = now;
}

function copy(){
  navigator.clipboard.writeText(els.note.value || '').then(()=> setStatus('Copied!'));
}

function download(){
  const blob = new Blob([els.note.value||''], {type:'text/markdown'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'clinical-note.md'; a.click();
  URL.revokeObjectURL(url);
}

// Wire up UI
restoreTranscript();
initSettingsUI();
els.start.addEventListener('click', start);
els.stop.addEventListener('click', stop);
els.summarize.addEventListener('click', summarize);
els.clear.addEventListener('click', ()=>{ els.transcript.value=''; dialogueTurns=[]; segments=[]; renderTranscript(); autosave(); setStatus('Cleared'); });
els.copy.addEventListener('click', copy);
els.download.addEventListener('click', download);
els.settingsBtn.addEventListener('click', ()=>{ initSettingsUI(); els.dialog.showModal(); });
els.saveSettings.addEventListener('click', ()=>{ saveSettings(); els.dialog.close(); });
els.segment.addEventListener('click', forceSegment);



import http from 'node:http';
import { URL } from 'node:url';
import { writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Simple .env loader (no dependencies)
try { const env = readFileSync(new URL('./.env', import.meta.url)).toString();
  env.split(/\r?\n/).forEach(l=>{ const m = /^([^#=]+)=(.*)$/.exec(l); if(m) process.env[m[1].trim()] = m[2].trim(); });
} catch {}

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY || '';
const MODEL = process.env.MODEL || 'qwen2.5-3b-instruct';

function cors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, POST');
}

function json(res, code, obj){
  cors(res); res.writeHead(code, {'Content-Type':'application/json'});
  res.end(JSON.stringify(obj));
}

function buildPrompt(transcript){
  return `You are a clinical documentation assistant.
Given the raw clinician-patient conversation below, produce a concise, medically coherent SOAP note.
- Summarize Subjective and Objective succinctly.
- Provide Assessment with likely diagnoses and rationale.
- Provide an actionable, numbered Plan (meds, tests, follow-up).
- Use markdown headers: Subjective, Objective, Assessment, Plan.
- Use only details supported by the transcript; avoid hallucinations.

Transcript:\n${transcript}`;
}

async function summarizeWithTogether(transcript){
  // Prefer a local Qwen adapter if configured
  if (process.env.LOCAL_QWEN_URL || process.env.LOCAL_QWEN_CMD){
    const local = await callLocalSummarize(transcript);
    if (local && (local.note || typeof local === 'string')){
      return { note: local.note || String(local), provider: 'local-qwen' };
    }
  }
  if (!TOGETHER_API_KEY){
    return { note: fallbackSOAP(transcript), provider: 'offline-fallback' };
  }
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You produce safe, concise clinical notes in SOAP format.' },
      { role: 'user', content: buildPrompt(transcript) },
    ],
    temperature: 0.2,
  };
  const res = await fetch('https://api.together.xyz/v1/chat/completions',{
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${TOGETHER_API_KEY}` },
    body: JSON.stringify(body)
  });
  if(!res.ok){
    const t = await res.text();
    throw new Error('Together API error: ' + t);
  }
  const data = await res.json();
  const note = data?.choices?.[0]?.message?.content || '';
  return { note, provider: 'together-qwen' };
}

async function callLocalSummarize(transcript){
  // LOCAL_QWEN_URL adapter: POST { transcript } and expect { note }
  if (process.env.LOCAL_QWEN_URL){
    try{
      const res = await fetch(process.env.LOCAL_QWEN_URL,{
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ transcript })
      });
      if (res.ok){
        const j = await res.json();
        return { note: j?.note || j?.output || (typeof j === 'string' ? j : JSON.stringify(j)) };
      }
      console.error('LOCAL_QWEN_URL responded with', res.status);
    }catch(e){ console.error('LOCAL_QWEN_URL error', e); }
  }
  // LOCAL_QWEN_CMD adapter: run command, pass JSON on stdin, read stdout
  if (process.env.LOCAL_QWEN_CMD){
    try{
      const cmd = process.env.LOCAL_QWEN_CMD;
      const out = spawnSync(cmd, { shell:true, input: JSON.stringify({ transcript }), encoding:'utf8', maxBuffer: 10 * 1024 * 1024 });
      if (out.status === 0){
        const txt = (out.stdout||'').trim();
        try{ const j = JSON.parse(txt); return { note: j?.note || j?.output || (typeof j === 'string' ? j : JSON.stringify(j)) }; }catch{ return txt; }
      }
      console.error('LOCAL_QWEN_CMD failed', out.stderr || out.stdout);
    }catch(e){ console.error('LOCAL_QWEN_CMD error', e); }
  }
  return null;
}

function fallbackSOAP(text){
  return `# Subjective\n${text}\n\n# Objective\nGeneral: NAD. Exam per transcript.\n\n# Assessment\nAssessment pending; see history.\n\n# Plan\n1) Continue current management as appropriate.\n2) Order tests or imaging if indicated.\n3) Follow-up as needed.`;
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS'){ res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Upload endpoint: receive raw audio binary and save to temp file
  if (req.method === 'POST' && url.pathname === '/upload'){
    try{
      // Read binary data
      const chunks = [];
      await new Promise((resolve, reject)=>{
        req.on('data', (c)=>chunks.push(c));
        req.on('end', resolve);
        req.on('error', reject);
      });
      const data = Buffer.concat(chunks);
      const tmpDir = join(tmpdir(), 'msa_uploads');
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
      const fname = join(tmpDir, `upload_${Date.now()}.webm`);
      writeFileSync(fname, data);
      return json(res, 200, { fileId: fname });
    }catch(err){ return json(res, 500, { error: String(err) }); }
  }

  // Chunked upload init: returns an uploadId
  if (req.method === 'POST' && url.pathname === '/upload_init'){
    try{
      const id = randomBytes(12).toString('hex');
      const tmpDir = join(tmpdir(), 'msa_uploads', `upload_${id}`);
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
      return json(res, 200, { uploadId: id });
    }catch(err){ return json(res, 500, { error: String(err) }); }
  }

  // Upload chunk: raw binary body -> saved as chunk_{index}
  if (req.method === 'POST' && url.pathname === '/upload_chunk'){
    try{
      const uploadId = url.searchParams.get('uploadId');
      const index = url.searchParams.get('index');
      if (!uploadId || !index) return json(res, 400, { error: 'Missing uploadId or index' });
      const chunks = [];
      await new Promise((resolve, reject)=>{
        req.on('data', (c)=>chunks.push(c));
        req.on('end', resolve);
        req.on('error', reject);
      });
      const data = Buffer.concat(chunks);
      const tmpDir = join(tmpdir(), 'msa_uploads', `upload_${uploadId}`);
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
      const partPath = join(tmpDir, `chunk_${String(index).padStart(6,'0')}`);
      writeFileSync(partPath, data);
      return json(res, 200, { ok: true, index });
    }catch(err){ return json(res, 500, { error: String(err) }); }
  }

  // Finalize upload: assemble chunks into single file
  if (req.method === 'POST' && url.pathname === '/upload_finalize'){
    try{
      const body = await new Promise((resolve,reject)=>{ let b=''; req.on('data',(c)=>b+=c); req.on('end',()=>resolve(b)); req.on('error',reject); });
      const { uploadId, filename } = JSON.parse(body||'{}');
      if (!uploadId) return json(res, 400, { error:'Missing uploadId' });
      const dir = join(tmpdir(), 'msa_uploads', `upload_${uploadId}`);
      if (!existsSync(dir)) return json(res, 400, { error:'uploadId not found' });
      const parts = readdirSync(dir).filter(f=>f.startsWith('chunk_')).sort();
      if (!parts.length) return json(res, 400, { error:'no chunks' });
      const outDir = join(tmpdir(), 'msa_uploads'); if (!existsSync(outDir)) mkdirSync(outDir, { recursive:true });
      const outName = filename && typeof filename === 'string' ? `upload_${Date.now()}_${filename}` : `upload_${Date.now()}.webm`;
      const outPath = join(outDir, outName);
      // Concatenate
      for (const p of parts){
        const ppath = join(dir, p);
        const data = readFileSync(ppath);
        appendFileSync(outPath, data);
      }
      // cleanup parts and dir
      for (const p of parts){ unlinkSync(join(dir,p)); }
      try{ unlinkSync(dir); }catch(e){}
      return json(res, 200, { fileId: outPath });
    }catch(err){ return json(res, 500, { error: String(err) }); }
  }
  if (req.method === 'POST' && url.pathname === '/attribute'){
    try{
      const body = await new Promise((resolve,reject)=>{ let b=''; req.on('data',(c)=>b+=c); req.on('end',()=>resolve(b)); req.on('error',reject); });
  const parsed = JSON.parse(body||'{}');
  const { segments, audioBase64, audioFileId } = parsed;
  if(!Array.isArray(segments) || segments.length===0) return json(res, 400, { error:'Missing segments' });
  // Forward payload; prefer audioFileId (server-stored file path) if present
  const payload = { segments, audioBase64, audioPath: audioFileId };
  const { dialogue, provider } = await attributeWithTogether(payload);
      return json(res, 200, { dialogue, provider: provider || 'together-qwen' });
    }catch(err){
      return json(res, 500, { error: String(err?.message||err) });
    }
  }
  if (req.method === 'POST' && url.pathname === '/summarize'){
    try{
      const body = await new Promise((resolve,reject)=>{
        let b=''; req.on('data',(c)=>b+=c); req.on('end',()=>resolve(b)); req.on('error',reject);
      });
      const { transcript, segments, audioFileId } = JSON.parse(body||'{}');
      let source = transcript;
      // If the source transcript is missing or doesn't contain speaker tags, run attribution
      if ((!source || !(/\[Clinician\]|\[Patient\]/.test(String(source)))) && Array.isArray(segments) && segments.length){
        const attr = await attributeWithTogether({ segments, audioPath: audioFileId });
        source = typeof attr === 'string' ? attr : attr?.dialogue || source;
      }
      if(!source) return json(res, 400, { error:'Missing transcript' });
      const out = await summarizeWithTogether(String(source).slice(0, 8000));
      return json(res, 200, out);
    }catch(err){
      return json(res, 500, { error: String(err?.message||err) });
    }
  }
  json(res, 404, { error:'Not found' });
});

server.listen(PORT, ()=>{
  console.log(`Medical Scribe Assistant API listening on http://localhost:${PORT}`);
});

function buildAttributionPrompt(segments){
  const items = segments.slice(0, 200).map((s,i)=>`${i+1}. [${s.ts ?? ''}] ${s.text}` ).join('\n');
  return `You will attribute each utterance to either Clinician or Patient.
Return the same utterances in order, one per line, strictly formatted as:
[Clinician] … or [Patient] …
Keep the original wording. Merge very short back-to-back lines from the SAME speaker where appropriate. Do not invent content.
Utterances:\n${items}`;
}

async function attributeWithTogether(payload){
  // payload: { segments, audioBase64 }
  const segments = Array.isArray(payload?.segments) ? payload.segments : [];
  const audioBase64 = payload?.audioBase64;
  // If a local adapter server is configured, forward the full payload to it so it can perform audio-based diarization
  if (process.env.LOCAL_QWEN_URL){
    try{
      const res = await fetch(process.env.LOCAL_QWEN_URL + '/attribute',{
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ segments, audioBase64, audioPath: payload?.audioPath })
      });
      if (res.ok){
        const j = await res.json();
        let dialogueText = j?.dialogue || j?.output || '';
        // If the adapter returned cluster samples, try to map clusters -> Clinician/Patient
        if (j?.clusters){
          try{
            const mapping = await callLocalRoleMapping(j.clusters);
            if (mapping){
              // Replace occurrences like [Speaker 0] with mapped role
              dialogueText = String(dialogueText).replace(/\[Speaker\s*(\d+)\]/g, (m,p)=>`[${mapping[String(p)] || ('Speaker ' + p)}]`);
            }
          }catch(e){ console.error('callLocalRoleMapping failed', e); }
        }
        return { dialogue: dialogueText, provider: 'local-adapter' };
      }
      console.error('LOCAL_QWEN_URL /attribute responded', res.status);
    }catch(e){ console.error('LOCAL_QWEN_URL /attribute error', e); }
  }
  // If no local adapter, fall back to previous heuristics
  if (!TOGETHER_API_KEY){
    // Offline fallback: label by simple content cues (improved heuristics)
    const lines = segments.map(s=>{
      const t = String(s.text || '').toLowerCase();
      let patientScore = 0, clinicianScore = 0;
      if (/(^|\s)(i |i'm |i have |my |me |mine )/.test(t)) patientScore += 1.6;
      if (/(hurts|pain|since|started|feels|feel|ache|cough|fever|dizzy|nausea)/.test(t)) patientScore += 1.2;
      if (/\b(doctor|doc)\b/.test(t)) patientScore += 1.2; // addressing the clinician
      if (/\?$/.test(t)) clinicianScore += 1.5;
      if (/(let's|we will|i recommend|i'll prescribe|start you on|examine|blood pressure|pulse|follow up|take|order|schedule|provide you with)/.test(t)) clinicianScore += 1.8;
      const sp = clinicianScore >= patientScore ? 'Clinician' : 'Patient';
      return `[${sp}] ${s.text}`;
    }).join('\n');
    return { dialogue: lines, provider: 'offline-fallback' };
  }
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You label medical conversations by speaker: Clinician or Patient.' },
      { role: 'user', content: buildAttributionPrompt(segments) },
    ],
    temperature: 0.1,
  };
  const res = await fetch('https://api.together.xyz/v1/chat/completions',{
    method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${TOGETHER_API_KEY}` },
    body: JSON.stringify(body)
  });
  if(!res.ok){ const t = await res.text(); throw new Error('Together API error: ' + t); }
  const data = await res.json();
  const dialogue = data?.choices?.[0]?.message?.content || '';
  return { dialogue, provider: 'together-qwen' };
}

async function callLocalAttribution(segments){
  // Try URL adapter first
  if (process.env.LOCAL_QWEN_URL){
    try{
      const res = await fetch(process.env.LOCAL_QWEN_URL,{
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ segments })
      });
      if (res.ok){
        const j = await res.json();
        // Expecting { dialogue: '...' } or plain string body
        return { dialogue: j?.dialogue || (typeof j === 'string' ? j : JSON.stringify(j)) };
      }
      console.error('LOCAL_QWEN_URL responded with', res.status);
    }catch(e){ console.error('LOCAL_QWEN_URL error', e); }
  }
  // Try CLI adapter
  if (process.env.LOCAL_QWEN_CMD){
    try{
      const cmd = process.env.LOCAL_QWEN_CMD;
      const out = spawnSync(cmd, { shell:true, input: JSON.stringify({ segments }), encoding:'utf8', maxBuffer: 10 * 1024 * 1024 });
      if (out.status === 0){
        const txt = (out.stdout||'').trim();
        try{ const j = JSON.parse(txt); return { dialogue: j?.dialogue || (typeof j === 'string' ? j : JSON.stringify(j)) }; }catch{ return { dialogue: txt }; }
      }
      console.error('LOCAL_QWEN_CMD failed', out.stderr || out.stdout);
    }catch(e){ console.error('LOCAL_QWEN_CMD error', e); }
  }
  return null;
}

async function callLocalRoleMapping(clusters){
  // clusters: { '<id>': [text, ...], ... }
  if (!clusters || typeof clusters !== 'object') return null;
  // Try HTTP adapter first
  if (process.env.LOCAL_QWEN_URL){
    try{
      const res = await fetch(process.env.LOCAL_QWEN_URL + '/classify_clusters',{
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ clusters })
      });
      if (res.ok){ const j = await res.json(); return j?.mapping || null; }
    }catch(e){ console.error('LOCAL_QWEN_URL classify_clusters error', e); }
  }
  // Try CLI adapter
  if (process.env.LOCAL_QWEN_CMD){
    try{
      const cmd = process.env.LOCAL_QWEN_CMD;
      const out = spawnSync(cmd, { shell:true, input: JSON.stringify({ clusters }), encoding:'utf8', maxBuffer: 10 * 1024 * 1024 });
      if (out.status === 0){
        const txt = (out.stdout||'').trim();
        try{ const j = JSON.parse(txt); return j?.mapping || null; }catch{ return null; }
      }
    }catch(e){ console.error('LOCAL_QWEN_CMD classify error', e); }
  }
  // Heuristic fallback: map cluster with more first-person pronouns to Patient; more questions to Clinician
  try{
    const mapping = {};
    const scores = {};
    for (const id of Object.keys(clusters)){
      const texts = Array.isArray(clusters[id]) ? clusters[id].join(' ') : String(clusters[id] || '');
      const t = texts.toLowerCase();
      let patientScore = 0, clinicianScore = 0;
      patientScore += (t.match(/\b(i |i'm |i have |my |me |mine )/g) || []).length;
      patientScore += (t.match(/\b(doctor|doc)\b/g) || []).length; // addressing clinician
      clinicianScore += (t.match(/\?/g) || []).length * 2;
      clinicianScore += (t.match(/\b(please|recommended|recommend|would you|could you|how long|when did|are you taking|any allergies)\b/g) || []).length;
      scores[id] = { patientScore, clinicianScore };
    }
    // Decide mapping: if clinicianScore >= patientScore -> Clinician else Patient
    for (const id of Object.keys(clusters)){
      const s = scores[id] || { patientScore:0, clinicianScore:0 };
      mapping[id] = (s.clinicianScore >= s.patientScore) ? 'Clinician' : 'Patient';
    }
    return mapping;
  }catch(e){ return null; }
}



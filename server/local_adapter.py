#!/usr/bin/env python3
"""
Local adapter for audio-based diarization using resemblyzer.
Endpoints:
 - POST /attribute  { segments: [...], audioBase64: '...' }
 - POST /summarize  { transcript: '...' }

This is a minimal implementation intended for development/testing.
It performs post-session diarization by:
 - decoding base64 audio to WAV
 - computing embeddings on sliding windows (1s windows)
 - clustering embeddings into k clusters (default k=2)
 - producing diarization segments and mapping them to transcript segments by order
 - returning dialogue lines labeled as [Speaker 1] / [Speaker 2]

To install dependencies (use virtualenv):
python -m venv .venv
.\.venv\Scripts\activate
pip install -U pip
pip install flask numpy scipy sklearn librosa soundfile resemblyzer torch

Note: resemblyzer requires PyTorch. On Windows, install a matching torch wheel; see https://pytorch.org
"""

import os
import io
import base64
import json
import tempfile
from flask import Flask, request, jsonify
import numpy as np
import soundfile as sf
import librosa
from resemblyzer import VoiceEncoder
from sklearn.cluster import AgglomerativeClustering

app = Flask(__name__)

encoder = None

def ensure_encoder():
    global encoder
    if encoder is None:
        encoder = VoiceEncoder()


def decode_audio_base64_to_np(b64str):
    data = base64.b64decode(b64str)
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        f.write(data)
        tmpname = f.name
    wav, sr = sf.read(tmpname)
    # Ensure mono
    if len(wav.shape) > 1:
        wav = np.mean(wav, axis=1)
    return wav.astype(np.float32), sr


def sliding_window_embeddings(wav, sr, window_s=1.0, hop_s=0.5):
    ensure_encoder()
    window_len = int(window_s * sr)
    hop_len = int(hop_s * sr)
    embeds = []
    starts = []
    for start in range(0, max(1, len(wav)-window_len+1), hop_len):
        w = wav[start:start+window_len]
        try:
            emb = encoder.embed_utterance(w)
        except Exception:
            emb = np.zeros((encoder.embedding_size,))
        embeds.append(emb)
        starts.append(start / sr)
    return np.vstack(embeds) if embeds else np.zeros((0, encoder.embedding_size)), np.array(starts)


def cluster_embeddings(embeds, k=2):
    if embeds.shape[0] == 0:
        return np.array([])
    if embeds.shape[0] <= k:
        return np.arange(embeds.shape[0]) % k
    cl = AgglomerativeClustering(n_clusters=k)
    labels = cl.fit_predict(embeds)
    return labels


def build_diarization_segments(starts, labels, window_s=1.0, hop_s=0.5):
    # Merge consecutive windows with same label
    segs = []
    if len(labels) == 0:
        return segs
    cur_label = labels[0]
    cur_start = starts[0]
    cur_end = starts[0] + window_s
    for i in range(1, len(labels)):
        if labels[i] == cur_label:
            cur_end = starts[i] + window_s
        else:
            segs.append({ 'label': int(cur_label), 'start': float(cur_start), 'end': float(cur_end) })
            cur_label = labels[i]
            cur_start = starts[i]
            cur_end = starts[i] + window_s
    segs.append({ 'label': int(cur_label), 'start': float(cur_start), 'end': float(cur_end) })
    return segs


def map_segments_to_transcript(diar_segs, transcript_segments, audio_duration):
    # Map each transcript segment index to the most frequent diarization label in its time window
    mapped = []
    n_text = max(1, len(transcript_segments))
    for i, t in enumerate(transcript_segments):
        # compute approximate start time proportionally
        frac_start = i / n_text
        frac_end = (i+1) / n_text
        st = frac_start * audio_duration
        ed = frac_end * audio_duration
        # find diar segs overlapping
        labels = []
        for ds in diar_segs:
            if not (ds['end'] <= st or ds['start'] >= ed):
                labels.append(ds['label'])
        if labels:
            # choose most common
            lab = int(max(set(labels), key=labels.count))
        else:
            # fallback: nearest segment by center
            centers = [ (ds['start']+ds['end'])/2.0 for ds in diar_segs ]
            if centers:
                idx = int(np.argmin([abs(c - ((st+ed)/2.0)) for c in centers]))
                lab = diar_segs[idx]['label']
            else:
                lab = 0
        mapped.append(lab)
    return mapped


@app.route('/attribute', methods=['POST'])
def attribute():
    data = request.get_json(force=True)
    segments = data.get('segments') or []
    audio_b64 = data.get('audioBase64')
    audio_path = data.get('audioPath')
    if not segments:
        return jsonify({ 'error': 'Missing segments' }), 400
    wav = None
    sr = None
    if audio_path:
        try:
            wav, sr = sf.read(audio_path)
            if len(wav.shape) > 1:
                wav = np.mean(wav, axis=1)
            wav = wav.astype(np.float32)
        except Exception as e:
            return jsonify({ 'error': f'Failed to read audio path: {e}' }), 400
    elif audio_b64:
        try:
            wav, sr = decode_audio_base64_to_np(audio_b64)
        except Exception as e:
            return jsonify({ 'error': f'Failed to decode audio: {e}' }), 400
    else:
        # No audio provided; fall back to returning speaker placeholders
        dialogue = "\n".join([f"[Speaker 0] {s.get('text','')}" for s in segments])
        return jsonify({ 'dialogue': dialogue })
    duration = len(wav) / sr
    embeds, starts = sliding_window_embeddings(wav, sr, window_s=1.0, hop_s=0.5)
    # default to k=2; can be extended later
    labels = cluster_embeddings(embeds, k=2)
    diar_segs = build_diarization_segments(starts, labels, window_s=1.0, hop_s=0.5)
    mapped = map_segments_to_transcript(diar_segs, segments, duration)
    # Build dialogue lines
    dialogue_lines = []
    for idx, seg in enumerate(segments):
        lab = mapped[idx] if idx < len(mapped) else 0
        dialogue_lines.append(f"[Speaker {lab}] {seg.get('text','')}")
    # Provide cluster samples for possible role mapping
    cluster_texts = {}
    for idx, lab in enumerate(mapped):
        cluster_texts.setdefault(str(lab), []).append(segments[idx].get('text',''))
    return jsonify({ 'dialogue': "\n".join(dialogue_lines), 'clusters': cluster_texts, 'diar': diar_segs })


@app.route('/summarize', methods=['POST'])
def summarize():
    data = request.get_json(force=True)
    transcript = data.get('transcript','')
    # This adapter focuses on diarization; summarization should be performed by your local Qwen setup.
    # We'll return a fallback note here.
    note = f"# Subjective\n{transcript}\n\n# Objective\nVitals and exam findings as observed during the visit.\n\n# Assessment\nAssessment pending.\n\n# Plan\n1) Follow-up as needed."
    return jsonify({ 'note': note })


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5001)

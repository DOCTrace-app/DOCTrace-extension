// Turn a session's narration audio into per-step text. Runs in the OFFSCREEN
// document (no 30 s fetch limit, has FormData + IndexedDB).
//
//   stored audio parts -> Whisper (Groq, whisper-large-v3-turbo, English)
//   -> timestamped phrases -> matched to steps by time -> SCRUBBED
//   -> step.narration, session.transcript
//
// The audio itself goes to the transcription API (separate voice consent).
// Only scrubbed text is stored next to the steps or reaches the guide LLM.

import { CONFIG } from '../config.js';
import { loadClassifier } from '../detection/mlClassifier.js';
import { scrubTextSync } from '../privacy/textScrubber.js';
import * as store from '../storage/sessionStore.js';
import { alignByMode, phrasesFromWhisper, INTRO_KEY, NARRATION_VERSION } from './narrationAlign.js';
import { analyzeOpusWebm } from './audioCheck.js';
import { SOUND_LEVEL } from './voiceRecorder.js';

export const TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const WHISPER_MODEL = 'whisper-large-v3-turbo';
const TIMEOUT_MS = 120000;
const MAX_NARRATION_CHARS = 1200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Whisper "prompt": words that appear on screen (button and page names). It
 * makes Whisper spell product terms right ("LMS", "Enrollment", "Fee Challans")
 * instead of guessing. Only scrubbed labels are used, never redacted values.
 */
export function vocabularyPrompt(steps) {
  const words = [];
  for (const s of steps) {
    for (const v of [s.targetLabel, s.pageTitle, s.clickedText]) {
      const t = String(v || '').trim();
      if (t && !/\[REDACTED:/.test(t) && t.length <= 60 && !words.includes(t)) words.push(t);
    }
  }
  // Only a bare word list: on quiet audio Whisper repeats prompt sentences back
  // (Recording 7: "On screen is a great tool..."). Echoes are also filtered below.
  const list = words.join(', ').slice(0, 400);
  return list ? `${list}.` : '';
}

const wordsOf = (s) => String(s || '').toLowerCase().match(/[a-z0-9']+/g) || [];

/** A segment that is mostly words from the prompt is an echo, not speech. */
export function isPromptEcho(text, prompt) {
  const words = wordsOf(text);
  if (!words.length || !prompt) return false;
  const vocab = new Set(wordsOf(prompt));
  const hits = words.filter((w) => vocab.has(w)).length;
  return words.length >= 2 && hits / words.length >= 0.8;
}

/** Drop Whisper's low-confidence guesses: they are what it produces from noise. */
export function reliableSegments(segments, prompt) {
  return (segments || []).filter((s) => !(Number(s?.avg_logprob) < -1.0)
    && !(Number(s?.compression_ratio) > 2.4)
    && !isPromptEcho(s?.text, prompt));
}

async function transcribePart(part, apiKey, model, fetchImpl, prompt) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const form = new FormData();
    const ext = /ogg/.test(part.mimeType) ? 'ogg' : 'webm';
    form.append('file', part.blob, `narration_${part.part}.${ext}`);
    form.append('model', model);
    form.append('language', 'en');
    form.append('temperature', '0');
    if (prompt) form.append('prompt', prompt);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(TRANSCRIBE_URL, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: controller.signal });
    } catch (err) {
      if (attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
      throw new Error(`Transcription request failed (${err?.name || 'Error'}).`);
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait * 1000, 65000) : 5000 * (attempt + 1));
      continue;
    }
    let code = '';
    try { const e = JSON.parse(await res.text())?.error; code = [e?.code, e?.type].filter((c) => typeof c === 'string' && /^[a-z0-9_]+$/i.test(c)).join(' / '); } catch { /* ignore */ }
    const hint = res.status === 401 ? ' Check the Groq API key in Options.' : '';
    throw new Error(`Transcription failed (HTTP ${res.status})${code ? ` - ${code}` : ''}.${hint}`);
  }
  throw new Error('Transcription failed after retries.');
}

/**
 * Stage 1 - Whisper only. Runs as soon as the recording stops, in parallel with
 * the last screenshots still being OCR'd. Stores the timestamped phrases
 * (scrubbed) on the session, so stage 2 and any later re-matching never need
 * to send the audio again.
 * @returns {{ ok, phrases, error? }}
 */
export async function transcribeAudio(sessionId, { apiKey, model = WHISPER_MODEL, fetchImpl = fetch } = {}) {
  const session = await store.getSession(sessionId);
  if (!session) return { ok: false, error: 'Unknown session' };
  const parts = await store.getAudio(sessionId);
  if (!parts.length) {
    await store.updateSession(sessionId, { voiceStatus: 'empty', voiceError: 'No voice was recorded for this session.' });
    return { ok: false, error: 'No audio' };
  }
  if (!apiKey) {
    const error = 'Voice was recorded, but no Groq API key is saved for transcription. Add it in Options, then click Generate manual.';
    await store.updateSession(sessionId, { voiceStatus: 'error', voiceError: error });
    return { ok: false, error };
  }
  await store.updateSession(sessionId, { voiceStatus: 'transcribing', voiceError: null });
  try {
    const steps = await store.getSteps(sessionId, { withImages: false }); // only for Whisper's vocabulary
    const prompt = vocabularyPrompt(steps);
    const phrases = [];
    let audioBytes = 0;
    let silentParts = 0;
    for (const part of parts) {
      audioBytes += part.blob?.size || 0;
      // Never send silence: Whisper invents text for it. Level from the live
      // monitor when known, else the packet-size check on the file itself.
      // Conservative: a quiet speaker must never be skipped, only a dead input.
      const deadByLevel = Number.isFinite(part.peakLevel) && part.peakLevel < SOUND_LEVEL / 5;
      const deadByFile = analyzeOpusWebm(new Uint8Array(await part.blob.arrayBuffer())).silent === true;
      if (deadByLevel || deadByFile) { silentParts += 1; continue; }
      const data = await transcribePart(part, apiKey, model, fetchImpl, prompt);
      phrases.push(...phrasesFromWhisper(reliableSegments(data?.segments, prompt), part.startedAt));
    }
    if (!phrases.length) {
      const device = parts[0]?.deviceLabel ? ` from "${parts[0].deviceLabel}"` : '';
      const error = silentParts === parts.length
        ? `The microphone recorded only silence${device}. It may be disconnected (for example a Bluetooth headset), muted, or the wrong device. In Settings > Voice narration, pick your microphone, click "Test microphone", then record again.`
        : `The voice recording (${Math.round(audioBytes / 1024)} KB) contains no recognizable speech. Pick and test your microphone in Settings > Voice narration, speak clearly, then record again.`;
      await store.updateSession(sessionId, { voiceStatus: 'error', voiceError: error, voiceSteps: 0 });
      return { ok: false, error };
    }
    const clf = await loadClassifier(CONFIG.ml.modelUrl);
    // PII filter on every phrase BEFORE it is stored: nothing unscrubbed is kept as text.
    const scrubbed = phrases.map((p) => ({ startMs: p.startMs, endMs: p.endMs, text: scrubTextSync(p.text, clf).text }));
    await store.updateSession(sessionId, {
      voiceStatus: 'transcribed',
      voiceError: null,
      narrationPhrases: scrubbed,
      transcript: scrubTextSync(phrases.map((p) => p.text).join(' '), clf).text,
      transcribedBy: `groq:${model}`,
    });
    return { ok: true, phrases: scrubbed.length };
  } catch (err) {
    const error = String(err?.message || err).split(apiKey).join('[key]').slice(0, 300);
    await store.updateSession(sessionId, { voiceStatus: 'error', voiceError: error });
    return { ok: false, error };
  }
}

/**
 * Stage 2 - match the stored phrases to the steps (local, instant).
 * matching: 'smart' (default) or 'timeWindow' (strict spec rule).
 * Narration the user corrected by hand on the Guides page is kept.
 * @returns {{ ok, stepsWithNarration, intro, error? }}
 */
export async function alignSession(sessionId, { matching = 'smart' } = {}) {
  const session = await store.getSession(sessionId);
  if (!session) return { ok: false, error: 'Unknown session' };
  if (!Array.isArray(session.narrationPhrases)) return { ok: false, error: 'Not transcribed yet' };
  const clf = await loadClassifier(CONFIG.ml.modelUrl);
  const steps = await store.getSteps(sessionId, { withImages: false });
  const byStep = alignByMode(matching, session.narrationPhrases, steps);
  for (const step of steps) {
    if (step.narrationEdited) continue;
    const raw = byStep.get(step.stepNumber) || '';
    const narration = raw ? scrubTextSync(raw, clf).text.slice(0, MAX_NARRATION_CHARS) : '';
    if ((step.narration || '') !== narration) await store.updateStep(sessionId, step.stepNumber, { narration });
  }
  const intro = byStep.get(INTRO_KEY) || '';
  await store.updateSession(sessionId, {
    voiceStatus: 'done',
    voiceError: null,
    narrationIntro: intro ? scrubTextSync(intro, clf).text.slice(0, MAX_NARRATION_CHARS) : '',
    narrationVersion: NARRATION_VERSION,
    narrationMatching: matching,
    voiceSteps: [...byStep.keys()].filter((k) => k !== INTRO_KEY).length,
  });
  return { ok: true, stepsWithNarration: byStep.size, intro: Boolean(intro) };
}

/** Both stages (Whisper only when the phrases are not stored yet). */
export async function transcribeSession(sessionId, { apiKey, model = WHISPER_MODEL, fetchImpl = fetch, matching = 'smart' } = {}) {
  const session = await store.getSession(sessionId);
  if (!Array.isArray(session?.narrationPhrases)) {
    const t = await transcribeAudio(sessionId, { apiKey, model, fetchImpl });
    if (!t.ok) return t;
  }
  return alignSession(sessionId, { matching });
}

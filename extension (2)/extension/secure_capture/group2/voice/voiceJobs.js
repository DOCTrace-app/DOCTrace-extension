// Voice work driven from the SERVICE WORKER (the audio itself lives in the
// offscreen document).
//
// Latency: Whisper used to start only after every screenshot was OCR'd and the
// session closed. Now startEarlyTranscription() runs it the moment the
// recording stops, in parallel with the remaining OCR. ensureNarration() then
// only has to wait for it (usually already done) and match phrases to steps,
// which is local and instant.

import { sendToOffscreen } from '../bridge/offscreenClient.js';
import { getSession } from '../storage/sessionStore.js';
import { loadSettings } from '../manual_generator/settings.js';
import { loadVoiceSettings } from './voiceSettings.js';
import { NARRATION_VERSION } from './narrationAlign.js';

const early = new Map(); // sessionId -> Promise of the Whisper stage

const groqKey = async () => (await loadSettings()).apiKeys?.groq || '';
const fail = (err) => ({ ok: false, error: String(err?.message || err) });

/** Start Whisper now (fire and forget); ensureNarration() picks the result up. */
export function startEarlyTranscription(sessionId) {
  if (early.has(sessionId)) return early.get(sessionId);
  const job = groqKey()
    .then((apiKey) => sendToOffscreen('VOICE_TRANSCRIBE_AUDIO', { sessionId, apiKey }))
    .catch(fail)
    .finally(() => setTimeout(() => early.delete(sessionId), 60000));
  early.set(sessionId, job);
  return job;
}

/**
 * Make sure the session's narration is transcribed and matched with the current
 * rules and matching mode. Whisper runs only if the phrases are not stored yet.
 * @returns true when narration changed (steps should be rewritten with it)
 */
export async function ensureNarration(sessionId) {
  let session = await getSession(sessionId);
  if (!session?.voice) return false;
  if (early.has(sessionId)) { await early.get(sessionId); session = await getSession(sessionId); }
  const { matching } = await loadVoiceSettings();
  const upToDate = session.voiceStatus === 'done' && session.narrationVersion === NARRATION_VERSION
    && (session.narrationMatching || 'smart') === matching;
  if (upToDate) return false;
  const res = Array.isArray(session.narrationPhrases)
    ? await sendToOffscreen('VOICE_ALIGN', { sessionId, matching }).catch(fail)          // re-match only, no Whisper
    : await sendToOffscreen('VOICE_TRANSCRIBE', { sessionId, apiKey: await groqKey(), matching }).catch(fail);
  if (!res?.ok) console.warn('DOCTrace: narration not ready', res?.error);
  return Boolean(res?.ok);
}

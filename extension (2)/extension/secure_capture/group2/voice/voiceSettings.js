// Voice narration settings (platform key-value store; chrome.storage.local in the extension).
//   enabled: record the microphone with every recording (popup switch)
//   consent: the user allowed their voice recording to be sent to Groq for
//            transcription, and knows the audio file is kept and exported
//            unscrubbed (Options page). Nothing is recorded without it.

import { platform } from '../platform/platform.js';

export const VOICE_KEY = 'dtVoiceSettings';
// Voice is OFF by default, so Start recording works on a fresh install without
// a microphone, consent or a Groq key. When the user turns it on, nothing is
// recorded until they also give consent: Start recording asks for it instead of
// silently recording without voice.
// deviceId: the microphone picked on the Options page ('' = system default).
// Device ids are per extension origin, so the Options page and the offscreen
// recorder see the same ids.
// matching: how spoken sentences are tied to steps (narrationAlign.js):
//   'smart'      - words, tense and "this is..." cues (best on real recordings)
//   'timeWindow' - strict: speech between click i and click i+1 belongs to step i
export const DEFAULT_VOICE = { enabled: false, consent: false, deviceId: '', deviceLabel: '', matching: 'smart' };

export async function loadVoiceSettings() {
  const data = await platform.kv.get(VOICE_KEY);
  return { ...DEFAULT_VOICE, ...(data[VOICE_KEY] || {}) };
}

export async function saveVoiceSettings(patch) {
  const next = { ...(await loadVoiceSettings()), ...patch };
  await platform.kv.set({ [VOICE_KEY]: next });
  return next;
}

export const voiceReady = (v) => Boolean(v?.enabled && v?.consent);

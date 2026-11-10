// Voice narration recorder. Runs in the OFFSCREEN document (the service worker
// cannot use the microphone).
//
//   startVoice(sessionId, { deviceId }) -> the chosen mic -> MediaRecorder (Opus 48 kbps)
//   every PART_MS a new part starts (each file stays far below the
//   transcription API's size limit: 20 min at 48 kbps is about 7 MB)
//   stopVoice(sessionId) -> last part saved -> mic released
//
// A level monitor watches the signal while recording. Chrome happily records
// pure silence from a disconnected Bluetooth headset or a muted device, so:
//   - after SILENT_AFTER_MS without any sound, the service worker is told
//     (SC_VOICE_LEVEL), and the page being recorded shows a warning
//   - each saved part carries its peak level, so silence is never sent to
//     Whisper (which would otherwise invent text)
// The audio is the user's own voice and is NOT scrubbed; only the transcript is.

import { putAudio } from '../storage/sessionStore.js';

const PART_MS = 20 * 60 * 1000;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
export const SOUND_LEVEL = 0.01;   // RMS above this = the mic hears something (speech is ~0.03-0.3)
const SILENT_AFTER_MS = 6000;      // warn if nothing was heard for this long

let active = null;

export async function micPermission() {
  try {
    return (await navigator.permissions.query({ name: 'microphone' })).state; // granted | prompt | denied
  } catch {
    return 'unknown';
  }
}

const pickMime = () => MIME_TYPES.find((t) => globalThis.MediaRecorder?.isTypeSupported?.(t)) || '';

function notifyLevel(silent) {
  if (!active || active.silentReported === silent) return;
  active.silentReported = silent;
  chrome.runtime.sendMessage({ type: 'SC_VOICE_LEVEL', sessionId: active.sessionId, silent, device: active.deviceLabel }).catch(() => {});
}

// RMS level of the mic, sampled 4x per second. Needs a running AudioContext;
// if Chrome keeps it suspended, levels stay unknown (monitored = false) and
// nothing is reported, so a working mic is never flagged by mistake.
function startMonitor() {
  try {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(active.stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    ctx.resume().catch(() => {});
    active.ctx = ctx;
    active.lastSoundAt = Date.now();
    active.monitorTimer = setInterval(() => {
      if (!active || ctx.state !== 'running') return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      const part = active.current;
      if (part) { part.monitored = true; part.peak = Math.max(part.peak, rms); }
      if (rms >= SOUND_LEVEL) { active.lastSoundAt = Date.now(); notifyLevel(false); }
      else if (Date.now() - active.lastSoundAt > SILENT_AFTER_MS) notifyLevel(true);
    }, 250);
  } catch (err) {
    console.warn('DOCTrace: microphone level monitor unavailable', err);
  }
}

function startPart() {
  const mimeType = pickMime();
  // 48 kbps Opus: clearly better speech than 32 kbps for Whisper.
  // Variable bitrate is required by the silence check in audioCheck.js (real sound
  // makes packet sizes vary; a dead input gives one fixed size).
  const recorder = new MediaRecorder(active.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 48000, audioBitrateMode: 'variable' });
  const part = { recorder, chunks: [], startedAt: Date.now(), mimeType: recorder.mimeType || mimeType || 'audio/webm', peak: 0, monitored: false };
  recorder.ondataavailable = (e) => { if (e.data?.size) part.chunks.push(e.data); };
  recorder.onstart = () => { part.startedAt = Date.now(); }; // wall clock of the first audio sample
  recorder.start(5000);
  active.current = part;
}

async function finishPart() {
  const part = active?.current;
  if (!part) return;
  active.current = null;
  if (part.recorder.state !== 'inactive') {
    await new Promise((resolve) => { part.recorder.onstop = resolve; part.recorder.stop(); });
  }
  const blob = new Blob(part.chunks, { type: part.mimeType });
  if (!blob.size) return;
  active.part += 1;
  await putAudio({
    sessionId: active.sessionId,
    part: active.part,
    startedAt: part.startedAt,
    durationMs: Date.now() - part.startedAt,
    mimeType: part.mimeType,
    deviceLabel: active.deviceLabel,
    peakLevel: part.monitored ? part.peak : null, // null = level unknown
    blob,
  });
}

const constraints = (deviceId) => ({
  // Noise suppression + auto gain keep quiet or distant speech audible for Whisper.
  echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
  ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
});

export async function startVoice(sessionId, { deviceId = '' } = {}) {
  if (active) await stopVoice(active.sessionId);
  let stream;
  let note = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraints(deviceId) });
  } catch (err) {
    // The chosen mic is gone (headset unplugged): use the system default instead of failing.
    if (!deviceId || !/NotFound|Overconstrained/i.test(err?.name || '')) throw err;
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraints('') });
    note = 'The selected microphone was not found; the system default was used.';
  }
  const track = stream.getAudioTracks()[0];
  active = { sessionId, stream, part: 0, current: null, deviceLabel: track?.label || 'unknown microphone', silentReported: null };
  track?.addEventListener('ended', () => notifyLevel(true)); // device unplugged mid-recording
  if (track?.muted) note = `${note ? `${note} ` : ''}The microphone reports it is muted.`;
  startPart();
  startMonitor();
  active.rotateTimer = setInterval(() => {
    finishPart().then(() => { if (active) startPart(); }).catch((err) => console.warn('DOCTrace: voice part failed', err));
  }, PART_MS);
  return { ok: true, recording: true, device: active.deviceLabel, note };
}

export async function stopVoice(sessionId) {
  if (!active || (sessionId && active.sessionId !== sessionId)) return { ok: true, recording: false, parts: 0 };
  clearInterval(active.rotateTimer);
  clearInterval(active.monitorTimer);
  const done = active;
  try {
    await finishPart();
  } finally {
    for (const track of done.stream.getTracks()) track.stop(); // release the microphone
    done.ctx?.close().catch(() => {});
    active = null;
  }
  return { ok: true, recording: false, parts: done.part, device: done.deviceLabel };
}

export const voiceStatus = () => ({ recording: Boolean(active), sessionId: active?.sessionId || null, device: active?.deviceLabel || null });

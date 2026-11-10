// Real-time recorder (service worker).
//
//   Start  -> new session "Recording N", folder Downloads\DOCTrace\Recording N
//   Click  -> content script reports it -> screenshot of the visible tab
//          -> same pipeline as always (OCR + PII masking, on this device)
//          -> redacted step saved in docTraceDB AND as step_N.png in the folder
//   Stop   -> wait for every step, write the manual, save manifest + manual.md
//
// State lives in the platform key-value store (chrome.storage.local), so it survives the service worker
// going to sleep between clicks. Raw screenshots are only in memory.
//
// Two chains keep fast clicks from dropping steps:
//   captureChain  numbers the step and takes the screenshot (rate-limited and
//                 retried by captureQueue.js) as soon as possible after the click
//   pushChain     hands frames to the offscreen pipeline in step order; it never
//                 delays the next screenshot

import { startRecording, pushFrameWithRetry, endRecording } from '../integration/recordingApi.js';
import { updateSession } from '../storage/sessionStore.js';
import { setDownloadBubble } from '../storage/folderSaver.js';
import { captureVisibleTabQueued } from './captureQueue.js';
import { sendToOffscreen } from '../bridge/offscreenClient.js';
import { loadVoiceSettings, voiceReady } from '../voice/voiceSettings.js';
import { startEarlyTranscription } from '../voice/voiceJobs.js';
import { platform } from '../platform/platform.js';

export const STATE_KEY = 'dtLiveState';
const COUNTER_KEY = 'dtRecordingCounter';
const LEGACY_COUNTER_KEY = 'scRecordingCounter'; // pre-DOCTrace name, read once so numbering continues
export const DWELL_MS = 7000; // idle time before an "observe" snapshot (7 s); 0 turns it off

let captureChain = Promise.resolve();
let pushChain = Promise.resolve();

// State, badge and pages go through the platform adapter. Tab queries and the
// content-script injection below stay Chrome-only: they are how THIS host sees
// clicks; a desktop build replaces them with OS-level input capture (PORTING.md).
export async function getLiveState() {
  const d = await platform.kv.get(STATE_KEY);
  return d[STATE_KEY] || { active: false };
}

async function setLiveState(state) {
  await platform.kv.set({ [STATE_KEY]: state });
  return state;
}

const badge = (text, color) => platform.ui.badge(text, color);

// Pages opened before the extension was (re)loaded have no content script yet.
async function injectInto(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content/recorder.js'] }); } catch (_) { /* chrome:// or Web Store */ }
}

const openMicPage = () => platform.ui.openPage('ui/mic.html');

export async function startLive() {
  const cur = await getLiveState();
  if (cur.active) return { ok: true, ...cur, alreadyRunning: true };

  // Voice narration: the microphone permission must exist before the recording
  // starts, otherwise the narration would silently be missing.
  const voiceSettings = await loadVoiceSettings();
  if (voiceSettings.enabled && !voiceSettings.consent) {
    // Never record silently without voice when the user wants voice: ask for consent first.
    platform.ui.openSettings();
    return { ok: false, error: 'Voice is on but needs your consent: tick both boxes in "Voice narration" on the Settings page, then press Start again (or untick "Record my voice").' };
  }
  const voice = voiceReady(voiceSettings);
  if (voice) {
    const perm = await sendToOffscreen('VOICE_PERMISSION').catch(() => ({ state: 'unknown' }));
    if (perm?.state === 'prompt' || perm?.state === 'denied') {
      await openMicPage();
      return { ok: false, error: 'Allow the microphone in the tab that just opened, then press Start recording again (or turn off "Record my voice").' };
    }
  }

  const saved = await platform.kv.get([COUNTER_KEY, LEGACY_COUNTER_KEY]);
  const counter = (saved[COUNTER_KEY] ?? saved[LEGACY_COUNTER_KEY] ?? 0) + 1;
  await platform.kv.set({ [COUNTER_KEY]: counter });
  const name = `Recording ${counter}`;
  const res = await startRecording({ sessionTitle: name, startTime: Date.now(), source: 'live-recorder' });
  if (!res.ok) return res;
  await updateSession(res.sessionId, { saveToFolder: true, saveFolderName: name, recordingNumber: counter });
  let voiceOn = false;
  if (voice) {
    const v = await sendToOffscreen('VOICE_START', { sessionId: res.sessionId, deviceId: voiceSettings.deviceId || '' })
      .catch((err) => ({ ok: false, error: String(err?.message || err) }));
    voiceOn = Boolean(v?.ok);
    await updateSession(res.sessionId, voiceOn
      ? { voice: true, voiceStatus: 'recording', voiceError: null, voiceDevice: v.device || '', voiceNote: v.note || null }
      : { voice: false, voiceStatus: 'error', voiceError: `The microphone could not be started (${v?.error || 'unknown error'}); this guide has no narration.` });
    if (!voiceOn && /NotAllowed|Permission/i.test(v?.error || '')) openMicPage();
  }
  const state = await setLiveState({ active: true, sessionId: res.sessionId, name, folder: `Downloads\\DOCTrace\\${name}`, steps: 0, startedAt: Date.now(), dwellMs: DWELL_MS, voice: voiceOn });
  await setDownloadBubble(false);
  await badge('REC', '#b42318');
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) if (t.id && /^https?:|^file:/.test(t.url || '')) injectInto(t.id);
  return { ok: true, ...state };
}

export async function stopLive() {
  const cur = await getLiveState();
  if (!cur.active) return { ok: false, error: 'No recording is running' };
  await setLiveState({ ...cur, active: false, stopping: true }); // content scripts stop reporting now
  // Final-state snapshot: the screen the user ended on is the concluding step,
  // even when they did not click anything there.
  const finalTab = await findRecordableTab(cur);
  if (finalTab) onLiveFrame({ actionType: 'complete', timestamp: Date.now() }, finalTab);
  await captureChain; // let the last clicks (and the final snapshot) finish capturing...
  await pushChain;    // ...and reach the pipeline, before the session is closed
  if (cur.voice) {
    // Save the last audio part before the session closes (transcription runs when it is done).
    const v = await sendToOffscreen('VOICE_STOP', { sessionId: cur.sessionId }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (!v?.ok) await updateSession(cur.sessionId, { voiceStatus: 'error', voiceError: `Voice recording could not be saved (${v?.error || 'unknown error'}).` }).catch(() => {});
    else {
      await updateSession(cur.sessionId, { voiceStatus: 'recorded', voiceParts: v.parts }).catch(() => {});
      startEarlyTranscription(cur.sessionId); // Whisper runs while the last screenshots are still being OCR'd
    }
  }
  const summary = await endRecording(cur.sessionId);
  await setLiveState({ active: false, lastSessionId: cur.sessionId, lastName: cur.name, lastFolder: cur.folder, lastSteps: summary.totalSteps ?? cur.steps });
  await setDownloadBubble(true);
  await badge('', '#253a8c');
  return { ok: true, name: cur.name, folder: cur.folder, sessionId: cur.sessionId, ...summary };
}

/**
 * The offscreen level monitor says the mic went silent (or came back).
 * The flag lives in the live state, so the popup and the recorded page
 * (content script banner) both show it.
 */
export async function setVoiceSilent(sessionId, silent, device) {
  const st = await getLiveState();
  if (!st.active || st.sessionId !== sessionId || Boolean(st.voiceSilent) === Boolean(silent)) return;
  await setLiveState({ ...st, voiceSilent: Boolean(silent), voiceDevice: device || st.voiceDevice || '' });
  await badge(silent ? 'MIC' : 'REC', silent ? '#d97706' : '#b42318');
}

const isWebPage = (tab) => Boolean(tab?.id && tab.windowId && /^https?:|^file:/.test(tab.url || ''));

/** The web page the user is looking at: the focused window first, else the window of the last step. */
async function findRecordableTab(state) {
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (isWebPage(focused)) return focused;
  if (state.lastWindowId) {
    const [inLast] = await chrome.tabs.query({ active: true, windowId: state.lastWindowId }).catch(() => []);
    if (isWebPage(inLast)) return inLast;
  }
  return null;
}

/** A click reported by the content script. */
export function onLiveClick(click, tab) {
  return onLiveFrame({ ...click, actionType: click.actionType === 'input' ? 'input' : 'click' }, tab);
}

/** The user stayed on a screen without interacting for the dwell time. */
export function onLiveObserve(observe, tab) {
  return onLiveFrame({ ...observe, actionType: 'observe', x: undefined, y: undefined, targetLabel: null }, tab, { mustBeActive: true });
}

/**
 * One step, whatever triggered it: click / input, observe (dwell) or complete (stop).
 * Screenshots are taken in trigger order; frames reach the pipeline in step order.
 */
function onLiveFrame(event, tab, { mustBeActive = false } = {}) {
  const captured = captureChain.then(async () => {
    const state = await getLiveState();
    if (!(state.active || state.stopping) || !tab?.windowId) return { ok: false, ignored: true };
    if (event.actionType === 'observe' && !state.active) return { ok: false, ignored: true };
    if (mustBeActive) {
      // A dwell snapshot from a tab that is no longer in front would capture the wrong screen.
      const [front] = await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []);
      if (front?.id !== tab.id) return { ok: false, ignored: true };
    }
    let imageDataUrl;
    try {
      imageDataUrl = await captureVisibleTabQueued(tab.windowId, { format: 'png' });
    } catch (err) {
      console.warn('DOCTrace: screenshot failed after retries', err?.message || err);
      return { ok: false, error: `Screenshot failed: ${err?.message || err}` };
    }
    // Re-read: stopLive may have changed the state while we were capturing.
    const latest = await getLiveState();
    const stepNumber = (latest.steps || 0) + 1;
    await setLiveState({ ...latest, steps: stepNumber, lastWindowId: tab.windowId });
    const hasClick = Number.isFinite(event.x) && Number.isFinite(event.y);
    return {
      ok: true,
      frame: {
        sessionId: state.sessionId,
        stepNumber,
        timestamp: event.timestamp || Date.now(),
        actionType: event.actionType,
        clickCoords: hasClick ? { x: event.x, y: event.y } : null,
        coordSpace: 'css',
        dpr: event.dpr,
        viewportWidth: event.viewportWidth || tab.width,
        targetLabel: event.targetLabel || '',
        pageTitle: event.pageTitle || tab.title || '',
        url: event.url || tab.url || '',
        dwellTimeMs: Number.isFinite(event.dwellTimeMs) ? event.dwellTimeMs : undefined,
        imageDataUrl,
      },
    };
  });
  captureChain = captured.catch(() => {});

  const pushed = pushChain.then(async () => {
    const res = await captured.catch((err) => ({ ok: false, error: String(err?.message || err) }));
    return res.ok ? pushFrameWithRetry(res.frame) : res;
  });
  pushChain = pushed.catch(() => {});
  return pushed;
}

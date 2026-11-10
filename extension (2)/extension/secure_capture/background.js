// Service worker for DOCTrace.
//
// Flow (all on this device):
//   1. Capture the visible tab (chrome.tabs.captureVisibleTab).
//   2. Send the raw frame to the offscreen document, which runs OCR,
//      sensitive-information detection and redaction (processFrame).
//   3. Save ONLY the redacted image and a short summary in
//      chrome.storage.session (memory only, cleared when the browser closes).
// The raw screenshot is never stored, never shown and never uploaded. If
// Gemini is selected with separate consent, only the stored redacted copy is sent.

import { processFrameInOffscreen } from './group2/bridge/offscreenClient.js';
import { ensureNarration } from './group2/voice/voiceJobs.js';
import { isWireBlob, wireToBlob } from './group2/bridge/blobCodec.js';
import { startRecording, pushFrame, endRecording, recordingStatus } from './group2/integration/recordingApi.js';
import { generateManual, generateStepDescription } from './group2/manual_generator/manualGenerator.js';
import { DEFAULT_SETTINGS, loadSettings } from './group2/manual_generator/settings.js';
import { startLive, stopLive, getLiveState, onLiveClick, onLiveObserve, setVoiceSilent } from './group2/recorder/liveRecorder.js';
import { captureVisibleTabQueued } from './group2/recorder/captureQueue.js';
import { saveStepImage, saveManualFiles, saveWholeSession } from './group2/storage/folderSaver.js';
import { getSession, listSessions, updateSession } from './group2/storage/sessionStore.js';
import { blobToDataUrl, countByType, dataUrlToBlob, STORAGE_KEY, totalCount } from './ui/lib/shared.js';

const SESSION_ID = crypto.randomUUID();
const SESSION_START = Date.now();
const MAX_STORED_BYTES = 7 * 1024 * 1024; // storage.session allows about 10 MB
let busy = false;

function notifyProgress(stage) {
  // The popup may be closed; then nobody listens and that is fine.
  chrome.runtime.sendMessage({ type: 'CAPTURE_PROGRESS', stage }).catch(() => {});
}

async function setBadge(text, color = '#253a8c') {
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
  } catch (_) { /* ignore */ }
}

function friendlyError(err) {
  const msg = String(err?.message || err || '');
  if (/cannot be captured|chrome:\/\/|edge:\/\/|webstore|extensions gallery|Cannot access/i.test(msg)) {
    return 'This page cannot be captured. Chrome blocks screenshots of its own pages and the Web Store.';
  }
  if (/activeTab|permission/i.test(msg)) {
    return 'Click the extension icon on the page you want to capture, then try again.';
  }
  return msg || 'Something went wrong.';
}

// Make the stored image small enough for storage.session if it is very large.
async function fitForStorage(blob) {
  if (blob.size <= MAX_STORED_BYTES) return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
}

async function captureAndProtect(tab) {
  if (busy) throw new Error('A capture is already being processed.');
  if (!tab?.id) throw new Error('No active tab found.');
  busy = true;
  await setBadge('...');
  try {
    notifyProgress('capturing');
    const rawDataUrl = await captureVisibleTabQueued(tab.windowId, { format: 'png' });
    const imageBlob = dataUrlToBlob(rawDataUrl);

    const bmp = await createImageBitmap(imageBlob);
    const width = bmp.width;
    const height = bmp.height;
    bmp.close();
    const dpr = tab.width ? Math.round((width / tab.width) * 100) / 100 : 1;

    notifyProgress('protecting');
    const result = await processFrameInOffscreen({
      frameId: crypto.randomUUID(),
      sessionId: SESSION_ID,
      tMs: Date.now() - SESSION_START,
      eventId: 'manual-capture',
      width,
      height,
      dpr,
      imageBlob,
      status: 'raw',
    });

    // Fail closed: nothing is saved when redaction did not succeed.
    if (result.status !== 'redacted') {
      throw new Error(`Could not protect this capture, so nothing was saved. (${result.error || 'unknown error'})`);
    }

    const stored = await fitForStorage(result.redactedBlob);
    const counts = countByType(result.piiRegions);
    const record = {
      id: result.frameId,
      createdAt: Date.now(),
      pageTitle: tab.title || '',
      pageHost: (() => { try { return new URL(tab.url).host; } catch { return ''; } })(),
      width,
      height,
      regionCount: totalCount(counts), // sensitive items, not boxes
      counts,
      wordCount: result.ocrText.length,
      imageDataUrl: await blobToDataUrl(stored),
    };
    await chrome.storage.session.set({ [STORAGE_KEY]: record });
    await setBadge(record.regionCount ? String(record.regionCount) : '', '#1f7a4d');
    notifyProgress('done');
    return { ok: true, id: record.id, regionCount: record.regionCount };
  } catch (err) {
    await setBadge('!', '#b42318');
    notifyProgress('error');
    return { ok: false, error: friendlyError(err) };
  } finally {
    busy = false;
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

// ---------- recorded sessions (partner recorder) ----------
// The partner recorder can call recordingApi.js directly when it runs in this
// service worker. From content scripts or pages it sends these messages:
//   SC_REC_START   { session: { sessionId?, sessionTitle?, startTime? } }
//   SC_REC_FRAME   { frame: { sessionId, stepNumber, timestamp, actionType, clickCoords, ..., imageDataUrl } }
//   SC_REC_END     { sessionId, endTime? }
//   SC_REC_STATUS  { sessionId }
//   SC_MANUAL_GENERATE { sessionId, force? }   (sessions page)
const recordingRoutes = {
  SC_REC_START: (msg) => startRecording(msg.session || {}),
  SC_REC_FRAME: (msg) => {
    const frame = { ...(msg.frame || {}) };
    if (isWireBlob(frame.image)) { frame.imageBlob = wireToBlob(frame.image); delete frame.image; }
    return pushFrame(frame);
  },
  SC_REC_END: (msg) => endRecording(msg.sessionId, { endTime: msg.endTime }),
  SC_REC_STATUS: (msg) => recordingStatus(msg.sessionId),
  SC_MANUAL_GENERATE: (msg) => runManual(async () => {
    const fresh = await ensureNarration(msg.sessionId); // retry transcription if it failed before
    return generateManual(msg.sessionId, { force: Boolean(msg.force) || fresh });
  }),
  // Guides page "Rewrite": one step again, from its (possibly corrected) narration.
  SC_STEP_REWRITE: (msg) => runManual(() => generateStepDescription(msg.sessionId, Number(msg.stepNumber))),
  SC_MANUAL_RECOVER: async () => {
    await recoverInterruptedManuals();
    return { ok: true };
  },
  // real-time recorder (popup buttons + content script clicks)
  SC_LIVE_START: () => startLive(),
  SC_LIVE_STOP: () => stopLive(),
  SC_LIVE_STATE: () => getLiveState(),
  SC_SAVE_FOLDER: async (msg) => ({ ok: true, folder: await saveWholeSession(msg.sessionId) }),
};


// LLM work runs one job at a time, in order (real-time steps stay in sequence).
//
// Keep-alive: Chrome stops an idle service worker after ~30 s. Waiting for a
// Gemini answer or a rate-limit retry is "idle", and a stopped worker left every
// step as a template. A cheap extension API call every 20 s resets the idle
// timer while LLM jobs are pending.
let manualChain = Promise.resolve();
let manualJobs = 0;
let keepAliveTimer = null;
function keepAlive(on) {
  if (on && !keepAliveTimer) keepAliveTimer = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  if (!on && keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}
function runManual(task) {
  manualJobs += 1;
  keepAlive(true);
  const run = manualChain.then(task).catch((err) => ({ ok: false, error: String(err?.message || err) }));
  manualChain = run.then(() => {}, () => {});
  return run.then((res) => {
    chrome.runtime.sendMessage({ type: 'SC_MANUAL_UPDATED' }).catch(() => {});
    return res;
  }).finally(() => {
    manualJobs -= 1;
    if (manualJobs === 0) keepAlive(false);
  });
}

// ensureNarration (voice -> per-step text, before any guide text is written)
// lives in group2/voice/voiceJobs.js: Whisper starts at Stop, matching is local.

async function onStepDone(msg) {
  if (msg.status !== 'redacted') return;
  saveStepImage(msg.sessionId, msg.stepNumber).catch(() => {}); // live recordings: step_N.png in the folder
  const settings = await loadSettings();
  // With voice, the narration only exists after the recording ends, so steps are
  // written then (with your words) instead of one by one without them.
  const live = await getLiveState();
  if (settings.mode === 'realtime' && !(live.voice && live.sessionId === msg.sessionId)) {
    runManual(() => generateStepDescription(msg.sessionId, msg.stepNumber, { settings }));
  }
}

async function onSessionDone(msg) {
  const settings = await loadSettings();
  // 1. Voice narration is transcribed and matched to the steps.
  // 2. End-of-session batch: reviews the whole sequence and fills every step that
  //    has no LLM description yet. With fresh narration, LLM steps are rewritten
  //    so they include what you said. User-edited text is always kept.
  await runManual(async () => {
    const fresh = await ensureNarration(msg.sessionId);
    if (settings.mode === 'off') return { ok: true, skipped: true };
    return generateManual(msg.sessionId, { settings, force: fresh });
  });
  const session = await getSession(msg.sessionId);
  if (session?.saveToFolder) await saveManualFiles(msg.sessionId).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg?.type === 'SC_STEP_DONE') { onStepDone(msg); return false; }
  if (msg?.type === 'SC_SESSION_DONE') { onSessionDone(msg); return false; }
  if (msg?.type === 'SC_LIVE_CLICK') { onLiveClick(msg.click || {}, sender.tab); return false; }
  if (msg?.type === 'SC_LIVE_OBSERVE') { onLiveObserve(msg.observe || {}, sender.tab); return false; }
  if (msg?.type === 'SC_VOICE_LEVEL') { setVoiceSilent(msg.sessionId, msg.silent, msg.device).catch(() => {}); return false; }
   
  const route = recordingRoutes[msg?.type];
  if (route) {
    Promise.resolve(route(msg)).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  return false;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg?.type === 'CAPTURE_ACTIVE_TAB') {
    activeTab().then(captureAndProtect).then(sendResponse, (err) => sendResponse({ ok: false, error: friendlyError(err) }));
    return true;
  }
  if (msg?.type === 'GET_STATUS') {
    sendResponse({ busy });
    return false;
  }
  if (msg?.type === 'CLEAR_BADGE') {
    setBadge('');
    return false;
  }
  return false;
});

// Keyboard shortcut (Alt+Shift+S): capture, then open the result page.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'capture-protect') return;
  const res = await captureAndProtect(tab || await activeTab());
  const page = chrome.runtime.getURL('ui/viewer.html') + (res.ok ? '' : `?error=${encodeURIComponent(res.error)}`);
  chrome.tabs.create({ url: page });
});

chrome.runtime.onInstalled.addListener(() => setBadge(''));

let recoveryPromise = null;
function recoverInterruptedManuals() {
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = (async () => {
    const sessions = await listSessions();
    for (const session of sessions) {
      if (session.status !== 'complete' || session.manualStatus !== 'generating') continue;
      const result = await runManual(() => generateManual(session.sessionId, {
        settings: { ...DEFAULT_SETTINGS, enabled: false },
      }));
      if (!result?.ok) {
        await updateSession(session.sessionId, {
          manualStatus: 'error',
          manualError: 'Generation was interrupted and could not be completed. Choose Generate manual to retry.',
        });
      }
    }
  })().finally(() => { recoveryPromise = null; });
  return recoveryPromise;
}

void recoverInterruptedManuals().catch(() => {
  console.error('Could not recover interrupted guide generation.');
});

// Recording API for the partner group's recorder.
//
// USE FROM THE SERVICE WORKER (where chrome.tabs.captureVisibleTab runs):
//
//   import { startRecording, pushFrame, endRecording } from './group2/integration/recordingApi.js';
//   const { sessionId } = await startRecording({ sessionTitle: 'Enroll in a course' });
//   await pushFrame({ sessionId, stepNumber: 1, timestamp: Date.now(), actionType: 'click',
//                     clickCoords: { x: 420, y: 180 }, dpr: 2, targetLabel: 'Course Enrollment', imageBlob });
//   const summary = await endRecording(sessionId);
//
// Other contexts (content scripts, pages) send messages instead; see
// background.js and INTEGRATION_RECORDING.md for the message schema.
// Every function resolves with { ok: true, ... } or { ok: false, code, error }. None throws.

import { sendToOffscreen } from '../bridge/offscreenClient.js';
import { blobToWire, dataUrlToBlob } from '../bridge/blobCodec.js';

const fail = (err, code = 'ERROR') => ({ ok: false, code, error: String(err?.message || err) });

export async function startRecording(session = {}) {
  try { return await sendToOffscreen('REC_START', { session }); } catch (err) { return fail(err); }
}

/** One interaction frame. Accepts imageBlob (Blob) or imageDataUrl (string). */
export async function pushFrame(frame) {
  try {
    if (!frame || typeof frame !== 'object') return fail('frame must be an object', 'INVALID_FRAME');
    let blob = frame.imageBlob;
    if (!(blob instanceof Blob) && typeof frame.imageDataUrl === 'string') blob = dataUrlToBlob(frame.imageDataUrl);
    if (!(blob instanceof Blob)) return fail('imageBlob or imageDataUrl is required', 'INVALID_FRAME');
    const { imageDataUrl, ...rest } = frame;
    return await sendToOffscreen('REC_FRAME', { frame: { ...rest, imageBlob: await blobToWire(blob) } });
  } catch (err) {
    return fail(err);
  }
}

/** pushFrame, waiting and retrying while the queue is full. */
export async function pushFrameWithRetry(frame, { retries = 20 } = {}) {
  for (let i = 0; ; i++) {
    const res = await pushFrame(frame);
    if (res.ok || res.code !== 'QUEUE_FULL' || i >= retries) return res;
    await new Promise((r) => setTimeout(r, res.retryAfterMs || 1500));
  }
}

/** Waits until every queued frame of the session is processed and stored. */
export async function endRecording(sessionId, { endTime } = {}) {
  try { return await sendToOffscreen('REC_END', { session: { sessionId, endTime } }); } catch (err) { return fail(err); }
}

export async function recordingStatus(sessionId) {
  try { return await sendToOffscreen('REC_STATUS', { sessionId }); } catch (err) { return fail(err); }
}

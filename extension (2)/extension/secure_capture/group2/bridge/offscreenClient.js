// For Group 1's service worker. Import this file from the service worker:
//
//   import { processFrameInOffscreen } from './group2/bridge/offscreenClient.js';
//   const out = await processFrameInOffscreen(rawFrame);
//   if (out.status === 'redacted') { /* safe to store as recording / upload */ }
//
// It creates the Group 2 offscreen document on first use, sends the frame to
// it through chrome.runtime messaging (inside the browser only) and returns
// the same contract as processFrame(). It never throws.

import { blobToWire, wireToBlob, isWireBlob } from './blobCodec.js';

const OFFSCREEN_PATH = 'group2/offscreen/offscreen.html';
const TARGET = 'group2-offscreen';
let creating = null;

async function hasOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    return ctx.length > 0;
  }
  return false;
}

export async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS', 'USER_MEDIA'],
      justification: 'Local OCR and PII redaction of screenshots (Tesseract.js in a Web Worker), and recording the user\'s voice narration while they record a guide.',
    }).finally(() => { creating = null; });
  }
  await creating;
}

export async function sendToOffscreen(type, data = {}) {
  await ensureOffscreen();
  return send({ target: TARGET, type, ...data });
}

async function send(message, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await chrome.runtime.sendMessage(message);
      if (res !== undefined) return res;
    } catch (err) {
      if (i === tries - 1) throw err;
    }
    await new Promise((r) => setTimeout(r, 150 * (i + 1))); // document still loading
  }
  throw new Error('Offscreen document did not answer');
}

function failed(frame, reason) {
  const out = { ...frame, status: 'failed', error: String(reason) };
  delete out.redactedBlob;
  delete out.piiRegions;
  delete out.ocrText;
  return out;
}

export async function processFrameInOffscreen(frame) {
  try {
    if (!(frame?.imageBlob instanceof Blob)) return failed(frame || {}, 'Invalid frame: imageBlob is missing');
    await ensureOffscreen();
    const wireFrame = { ...frame, imageBlob: await blobToWire(frame.imageBlob) };
    const res = await send({ target: TARGET, type: 'GROUP2_PROCESS_FRAME', frame: wireFrame });
    if (!res?.ok) return failed(frame, res?.error || 'Offscreen processing failed');
    const result = { ...res.frame };
    if (isWireBlob(result.redactedBlob)) result.redactedBlob = wireToBlob(result.redactedBlob);
    if (result.status !== 'redacted') return failed(frame, result.error || 'Processing failed');
    return {
      ...frame,
      ocrText: result.ocrText,
      piiRegions: result.piiRegions,
      redactedBlob: result.redactedBlob,
      status: 'redacted',
      // identity fields and the original imageBlob come from the caller's frame, unchanged
      frameId: frame.frameId,
      sessionId: frame.sessionId,
      tMs: frame.tMs,
      eventId: frame.eventId,
      imageBlob: frame.imageBlob,
    };
  } catch (err) {
    return failed(frame || {}, err?.message || err);
  }
}

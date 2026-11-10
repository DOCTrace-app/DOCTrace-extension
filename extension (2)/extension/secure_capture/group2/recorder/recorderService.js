// Recorder service. Runs in the OFFSCREEN document, next to the OCR worker.
//
//   partner frame -> validate -> FIFO queue -> processFrame (OCR + PII + mask)
//                 -> scrub metadata -> store REDACTED step in docTraceDB -> notify
//
// The raw imageBlob lives only in memory until its job finishes, then it is
// released. It is never written to storage and never leaves this document.
// This file makes NO network calls (the LLM runs in the service worker and only
// ever reads scrubbed records from the database).

import { CONFIG } from '../config.js';
import { processFrame } from '../pipeline.js';
import { loadClassifier } from '../detection/mlClassifier.js';
import { REDACTION_TOKEN } from '../detection/detector.js';
import { clickInsideRegion } from '../redaction/redactor.js';
import { scrubTextSync, scrubUrlSync } from '../privacy/textScrubber.js';
import { FrameQueue } from './frameQueue.js';
import { ocrWorkerCount } from '../ocr/ocrPool.js';
import * as store from '../storage/sessionStore.js';

// observe: dwell snapshot (user stayed on a screen); complete: final state when recording stops.
const ACTIONS = new Set(['click', 'input', 'navigate', 'observe', 'complete']);
const PASSIVE = new Set(['observe', 'complete']); // no element was acted on
const accepted = new Map(); // sessionId -> Set of stepNumbers already queued or stored
const highest = new Map();  // sessionId -> highest stepNumber seen

export class RecorderError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const queue = new FrameQueue(processJob, {
  maxQueued: CONFIG.recorder.maxQueuedFrames,
  concurrency: ocrWorkerCount(), // one frame per OCR worker at a time
  onError: (err, job) => storeFailedStep(job, err?.message || String(err)),
});

function notify(message) {
  chrome.runtime.sendMessage(message).catch(() => {}); // nobody listening is fine
}

// ---------- session lifecycle ----------
export async function startSession({ sessionId, sessionTitle, startTime, source } = {}) {
  const id = sessionId ? String(sessionId) : crypto.randomUUID();
  const existing = await store.getSession(id);
  if (existing) {
    if (existing.status !== 'recording') throw new RecorderError('SESSION_ENDED', `Session ${id} has already ended`);
    return { sessionId: id, resumed: true };
  }
  const clf = await loadClassifier(CONFIG.ml.modelUrl);
  const title = scrubTextSync(sessionTitle || '', clf).text.trim();
  const t0 = Number.isFinite(startTime) ? startTime : Date.now();
  await store.putSession({
    sessionId: id,
    sessionTitle: title || `Recording ${new Date(t0).toLocaleString()}`,
    startTime: t0,
    endTime: null,
    status: 'recording',
    totalSteps: 0,
    failedSteps: 0,
    piiSummary: {},
    manualStatus: 'none',
    manualGeneratedBy: null,
    source: source ? String(source).slice(0, 60) : 'partner-recorder',
  });
  accepted.set(id, new Set());
  highest.set(id, 0);
  notify({ type: 'SC_SESSION_STARTED', sessionId: id });
  return { sessionId: id, resumed: false };
}

export async function enqueueFrame(payload) {
  const p = payload || {};
  const sessionId = p.sessionId ? String(p.sessionId) : '';
  const session = sessionId ? await store.getSession(sessionId) : null;
  if (!session) throw new RecorderError('UNKNOWN_SESSION', 'Start the session first (SC_REC_START)');
  if (session.status !== 'recording') throw new RecorderError('SESSION_ENDED', `Session ${sessionId} has already ended`);
  if (!(p.imageBlob instanceof Blob) || p.imageBlob.size === 0) throw new RecorderError('INVALID_FRAME', 'imageBlob is missing or empty');
  if (!ACTIONS.has(p.actionType)) throw new RecorderError('INVALID_FRAME', `actionType must be one of: ${[...ACTIONS].join(', ')}`);

  if (!accepted.has(sessionId)) {
    // Offscreen document was restarted: rebuild what we know from storage.
    const steps = await store.getSteps(sessionId, { withImages: false });
    accepted.set(sessionId, new Set(steps.map((s) => s.stepNumber)));
    highest.set(sessionId, Math.max(0, ...steps.map((s) => s.stepNumber)));
  }
  const seen = accepted.get(sessionId);
  let stepNumber = Number(p.stepNumber);
  if (!Number.isInteger(stepNumber) || stepNumber < 1) stepNumber = highest.get(sessionId) + 1;
  if (seen.has(stepNumber)) throw new RecorderError('DUPLICATE_STEP', `Step ${stepNumber} was already received`);

  const clickCoords = p.clickCoords && Number.isFinite(p.clickCoords.x) && Number.isFinite(p.clickCoords.y)
    ? { x: p.clickCoords.x, y: p.clickCoords.y } : null;

  const job = {
    sessionId,
    sessionStart: session.startTime,
    stepNumber,
    frameId: p.frameId ? String(p.frameId) : crypto.randomUUID(),
    eventId: p.eventId ? String(p.eventId) : `${sessionId}:${stepNumber}`,
    timestamp: Number.isFinite(p.timestamp) ? p.timestamp : Date.now(),
    actionType: p.actionType,
    clickCoords,
    coordSpace: p.coordSpace === 'image' ? 'image' : 'css',
    dpr: Number.isFinite(p.dpr) && p.dpr > 0 ? p.dpr : null,
    viewportWidth: Number.isFinite(p.viewportWidth) ? p.viewportWidth : null,
    targetLabel: !PASSIVE.has(p.actionType) && typeof p.targetLabel === 'string' ? p.targetLabel.slice(0, 300) : '',
    dwellTimeMs: Number.isFinite(p.dwellTimeMs) && p.dwellTimeMs >= 0 ? p.dwellTimeMs : null,
    pageTitle: typeof p.pageTitle === 'string' ? p.pageTitle.slice(0, 200) : '',
    url: typeof p.url === 'string' ? p.url.slice(0, 2000) : '',
    hadInputValue: p.inputValue !== undefined, // the typed value itself is never kept
    imageBlob: p.imageBlob,
  };
  const res = queue.push(job);
  if (!res.accepted) {
    throw new RecorderError('QUEUE_FULL', 'Too many frames waiting; retry shortly', { retryAfterMs: CONFIG.recorder.retryAfterMs });
  }
  seen.add(stepNumber);
  highest.set(sessionId, Math.max(highest.get(sessionId), stepNumber));
  return { accepted: true, sessionId, stepNumber, queued: res.queued };
}

export async function endSession({ sessionId, endTime } = {}) {
  const session = sessionId ? await store.getSession(String(sessionId)) : null;
  if (!session) throw new RecorderError('UNKNOWN_SESSION', 'Unknown sessionId');
  if (session.status === 'recording') await store.updateSession(session.sessionId, { status: 'processing' });
  await queue.drain((job) => job?.sessionId === session.sessionId); // finish every queued frame first

  const steps = await store.getSteps(session.sessionId, { withImages: false });
  const numbers = steps.map((s) => s.stepNumber);
  const max = Math.max(0, ...numbers);
  const missingSteps = [];
  for (let n = 1; n <= max; n++) if (!numbers.includes(n)) missingSteps.push(n);
  const failedSteps = steps.filter((s) => s.status !== 'redacted').map((s) => s.stepNumber);

  await store.updateSession(session.sessionId, {
    status: 'complete',
    endTime: Number.isFinite(endTime) ? endTime : Date.now(),
    totalSteps: steps.length,
    failedSteps: failedSteps.length,
  });
  accepted.delete(session.sessionId);
  highest.delete(session.sessionId);
  const summary = { sessionId: session.sessionId, totalSteps: steps.length, failedSteps, missingSteps };
  notify({ type: 'SC_SESSION_DONE', ...summary });
  return summary;
}

export async function getStatus(sessionId) {
  const session = await store.getSession(String(sessionId));
  if (!session) throw new RecorderError('UNKNOWN_SESSION', 'Unknown sessionId');
  return { ...session, queuedFrames: queue.size };
}

// ---------- per-frame work ----------
async function imageSize(blob) {
  const bmp = await createImageBitmap(blob);
  const size = { width: bmp.width, height: bmp.height };
  bmp.close();
  return size;
}

function toImagePoint(job, width) {
  if (!job.clickCoords) return { point: null, dpr: job.dpr || 1 };
  let dpr = job.dpr;
  if (!dpr && job.viewportWidth) dpr = width / job.viewportWidth;
  if (!dpr) dpr = 1;
  const scale = job.coordSpace === 'image' ? 1 : dpr;
  return { point: { x: Math.round(job.clickCoords.x * scale), y: Math.round(job.clickCoords.y * scale) }, dpr };
}

// Words near the click, nearest first. ocrText is already masked.
function nearClickText(words, p) {
  if (!p) return '';
  const r = CONFIG.recorder.nearClickRadius;
  return words
    .map((w) => ({ w, d: Math.hypot(w.box.x + w.box.w / 2 - p.x, w.box.y + w.box.h / 2 - p.y) }))
    .filter((x) => x.d <= r)
    .sort((a, b) => a.d - b.d)
    .slice(0, CONFIG.recorder.nearClickMaxWords)
    // back into reading order (top to bottom, left to right) so it reads as text
    .sort((a, b) => (Math.abs(a.w.box.y - b.w.box.y) > a.w.box.h / 2 ? a.w.box.y - b.w.box.y : a.w.box.x - b.w.box.x))
    .map((x) => x.w.text)
    .filter((t, i, arr) => !(isRedactionToken(t) && arr[i - 1] === t))
    .join(' ');
}

// The label under the click: the word that contains the point, extended to
// its neighbours on the same row ("Course" + "Enrollment").
function clickedText(words, p) {
  if (!p) return '';
  const hit = words.find((w) => p.x >= w.box.x - 6 && p.x <= w.box.x + w.box.w + 6 && p.y >= w.box.y - 6 && p.y <= w.box.y + w.box.h + 6);
  if (!hit) return '';
  const h = hit.box.h;
  const row = words
    .filter((w) => Math.abs((w.box.y + w.box.h / 2) - (hit.box.y + h / 2)) <= 0.5 * h)
    .sort((a, b) => a.box.x - b.box.x);
  const i = row.indexOf(hit);
  let lo = i; let hi = i;
  while (lo > 0 && row[lo].box.x - (row[lo - 1].box.x + row[lo - 1].box.w) <= 1.2 * h) lo--;
  while (hi < row.length - 1 && row[hi + 1].box.x - (row[hi].box.x + row[hi].box.w) <= 1.2 * h) hi++;
  return row.slice(lo, hi + 1).map((w) => w.text)
    .filter((t, i, arr) => !(isRedactionToken(t) && arr[i - 1] === t))
    .join(' ').slice(0, 120);
}

async function processJob(job) {
  const clf = await loadClassifier(CONFIG.ml.modelUrl);
  let size;
  try {
    size = await imageSize(job.imageBlob);
  } catch (err) {
    await storeFailedStep(job, `Could not decode imageBlob: ${err.message}`);
    return;
  }
  const { point, dpr } = toImagePoint(job, size.width);
  const frame = {
    frameId: job.frameId,
    sessionId: job.sessionId,
    tMs: Math.max(0, job.timestamp - (job.sessionStart || job.timestamp)),
    eventId: job.eventId,
    width: size.width,
    height: size.height,
    dpr,
    imageBlob: job.imageBlob,
    status: 'raw',
  };
  const result = await processFrame(frame, { clickPoint: point });
  job.imageBlob = null; // release the raw screenshot as soon as possible

  if (result.status !== 'redacted') {
    await storeFailedStep(job, result.error);
    return;
  }

  const label = scrubTextSync(job.targetLabel, clf);
  const title = scrubTextSync(job.pageTitle, clf);
  const piiTypes = [...new Set([...result.piiRegions.map((r) => r.type), ...label.types, ...title.types])].sort();
  const step = {
    sessionId: job.sessionId,
    stepNumber: job.stepNumber,
    frameId: job.frameId,
    eventId: job.eventId,
    timestamp: job.timestamp,
    action: job.actionType,
    clickCoords: point,                         // IMAGE pixels, matches the stored screenshot
    clickOnRedactedArea: point ? clickInsideRegion(point, result.piiRegions) : false,
    targetLabel: PASSIVE.has(job.actionType) ? null : label.text,
    dwellTimeMs: job.dwellTimeMs,
    pageTitle: title.text,
    url: scrubUrlSync(job.url, clf),
    inputValueDropped: job.hadInputValue,
    width: size.width,
    height: size.height,
    status: 'redacted',
    redactedImageFileName: `step_${job.stepNumber}.png`,
    redactedBlob: result.redactedBlob,          // REDACTED pixels only
    scrubbedOcrText: result.scrubbedText,
    clickedText: clickedText(result.ocrText, point),
    nearClickText: nearClickText(result.ocrText, point),
    detectedPiiSummary: piiTypes,
    piiRegions: result.piiRegions.map((r) => ({ type: r.type, box: r.box })),
    manualTitle: '',
    manualDescription: '',
    descriptionSource: null,
  };
  await store.putStep(step);
  await store.updateSession(job.sessionId, (s) => {
    const pii = { ...(s.piiSummary || {}) };
    for (const t of piiTypes) pii[t] = (pii[t] || 0) + 1;
    return { totalSteps: (s.totalSteps || 0) + 1, piiSummary: pii };
  });
  notify({ type: 'SC_STEP_DONE', sessionId: job.sessionId, stepNumber: job.stepNumber, status: 'redacted', piiTypes });
}

async function storeFailedStep(job, reason) {
  if (!job) return;
  job.imageBlob = null;
  try {
    await store.putStep({
      sessionId: job.sessionId,
      stepNumber: job.stepNumber,
      frameId: job.frameId,
      eventId: job.eventId,
      timestamp: job.timestamp,
      action: job.actionType,
      clickCoords: null,
      targetLabel: '',
      url: '',
      status: 'failed',
      error: String(reason || 'unknown error').slice(0, 300),
      redactedImageFileName: null,
      redactedBlob: null,
      scrubbedOcrText: '',
      clickedText: '',
      nearClickText: '',
      detectedPiiSummary: [],
      manualTitle: '',
      manualDescription: '',
      descriptionSource: null,
    });
    await store.updateSession(job.sessionId, (s) => ({ totalSteps: (s.totalSteps || 0) + 1, failedSteps: (s.failedSteps || 0) + 1 }));
  } catch (_) { /* storage problem: nothing more we can do safely */ }
  notify({ type: 'SC_STEP_DONE', sessionId: job.sessionId, stepNumber: job.stepNumber, status: 'failed' });
}

export const isRedactionToken = (s) => REDACTION_TOKEN.test(s);

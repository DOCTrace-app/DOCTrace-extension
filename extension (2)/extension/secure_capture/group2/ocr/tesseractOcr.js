// Local OCR with Tesseract.js (WebAssembly). Runs inside the offscreen
// document; Tesseract itself does the heavy work in its own Web Worker.
//
// Privacy settings that matter:
//   - workerPath / corePath / langPath point to files INSIDE the extension,
//     so Tesseract never downloads anything from a CDN.
//   - workerBlobURL: false  -> MV3 CSP does not allow blob: workers.
//   - cacheMethod: 'none'   -> Tesseract does not create its own IndexedDB
//     cache database (we must only use Group 1's "scribeDB").

import Tesseract from '../vendor/tesseract/tesseract.esm.min.js';
import { CONFIG } from '../config.js';
import { parseTesseractData } from './parseTesseract.js';
import { ocrWorkerCount } from './ocrPool.js';

const VENDOR = new URL('../vendor/tesseract/', import.meta.url).href;

// A small pool: slot i owns its own worker and runs one recognize() at a time,
// so a worker is never handed two images (the crash the FIFO queue prevents).
// Extra workers are created only when two screenshots actually overlap.
const slots = Array.from({ length: ocrWorkerCount() }, () => ({ workerPromise: null, busy: false }));
const slotWaiters = [];

async function acquireSlot() {
  const free = slots.find((s) => !s.busy);
  if (free) { free.busy = true; return free; }
  return new Promise((resolve) => slotWaiters.push(resolve));
}

function releaseSlot(slot) {
  const next = slotWaiters.shift();
  if (next) next(slot); // hand the slot straight to the next waiting image
  else slot.busy = false;
}

async function createOcrWorker() {
  const worker = await Tesseract.createWorker(CONFIG.ocr.language, 1 /* OEM LSTM only */, {
    workerPath: VENDOR + 'worker.min.js',
    corePath: VENDOR + 'core/',
    langPath: VENDOR + 'lang',
    workerBlobURL: false,
    cacheMethod: 'none',
    gzip: true,
  });
  await worker.setParameters({
    tessedit_pageseg_mode: CONFIG.ocr.pageSegMode,
    preserve_interword_spaces: '1',
    // Screenshots carry no DPI, so Tesseract guessed one per image and logged
    // "Estimating resolution as N" (shown on chrome://extensions as errors).
    // Its guesses were ~200-370; a fixed 300 avoids the guess and the noise.
    user_defined_dpi: '300',
  });
  return worker;
}

function workerFor(slot) {
  if (!slot.workerPromise) {
    slot.workerPromise = createOcrWorker().catch((err) => {
      slot.workerPromise = null; // allow a retry next time
      throw err;
    });
  }
  return slot.workerPromise;
}

/** The first pool worker (kept for callers that warm up OCR). */
export function getOcrWorker() {
  return workerFor(slots[0]);
}

async function resetSlot(slot) {
  const p = slot.workerPromise;
  slot.workerPromise = null;
  if (p) {
    try { (await p).terminate(); } catch (_) { /* ignore */ }
  }
}

export async function resetOcrWorker() {
  await Promise.all(slots.map(resetSlot));
}

export function chooseScale(dpr, width) {
  const mode = CONFIG.ocr.upscale;
  if (typeof mode === 'number') return mode;
  if (mode !== 'auto') return 1;
  const small = !dpr || dpr < 1.5;
  return small && width * 2 <= CONFIG.ocr.maxUpscaledWidth ? 2 : 1;
}

async function upscaledBlob(bitmap, scale) {
  const canvas = new OffscreenCanvas(bitmap.width * scale, bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: 'image/png' });
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run OCR on a decoded screenshot.
 * @param {Blob} imageBlob  original screenshot (never modified)
 * @param {ImageBitmap} bitmap  decoded image, gives the real pixel size
 * @param {number} dpr
 * @returns {Promise<{lines, scale}>} boxes are in ORIGINAL screenshot pixels
 */
export async function runOcr(imageBlob, bitmap, dpr) {
  const scale = chooseScale(dpr, bitmap.width);
  const input = scale === 1 ? imageBlob : await upscaledBlob(bitmap, scale);
  const slot = await acquireSlot();
  let result;
  try {
    const worker = await workerFor(slot);
    result = await withTimeout(worker.recognize(input), CONFIG.ocr.timeoutMs, 'OCR timed out');
  } catch (err) {
    await resetSlot(slot); // a stuck worker is thrown away (only this one)
    throw err;
  } finally {
    releaseSlot(slot);
  }
  return { lines: parseTesseractData(result.data, scale), scale };
}

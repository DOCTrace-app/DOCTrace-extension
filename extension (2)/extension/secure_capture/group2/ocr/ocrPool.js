// How many screenshots may be OCR'd at the same time, and a tiny async limiter.
// Kept apart from tesseractOcr.js so importing it never loads the WASM.

import { CONFIG } from '../config.js';

export function ocrWorkerCount(cores = globalThis.navigator?.hardwareConcurrency) {
  const w = CONFIG.ocr.workers;
  if (Number.isInteger(w) && w >= 1) return Math.min(w, 4);
  return Number(cores) >= 4 ? 2 : 1;
}

/** At most `max` tasks run at once; the rest wait in arrival (FIFO) order. */
export function createLimiter(max) {
  let running = 0;
  const waiting = [];
  const next = () => {
    if (running >= max || !waiting.length) return;
    running += 1;
    const { task, resolve, reject } = waiting.shift();
    Promise.resolve().then(task).then(resolve, reject).finally(() => { running -= 1; next(); });
  };
  return {
    run(task) {
      return new Promise((resolve, reject) => { waiting.push({ task, resolve, reject }); next(); });
    },
    get running() { return running; },
    get waiting() { return waiting.length; },
  };
}

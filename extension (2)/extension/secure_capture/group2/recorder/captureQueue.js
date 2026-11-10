// One queue for every screenshot of the visible tab (platform.capture.visibleTab,
// chrome.tabs.captureVisibleTab in the extension).
//
// Chrome allows only MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND (2) captures per
// second. Fast clicks used to exceed it, and the failed capture dropped the step.
// Now:
//   - captures run strictly one at a time, in click order (FIFO)
//   - at least MIN_GAP_MS passes between two captures
//   - a quota error is retried with exponential backoff instead of dropping the step
// Other errors (chrome:// pages, closed windows) fail at once: retrying cannot help.

import { platform } from '../platform/platform.js';

export const MIN_GAP_MS = 500;            // 2 per second is Chrome's hard limit
export const RETRY_DELAYS_MS = [500, 1000, 2000, 4000];

const QUOTA_ERROR = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i;
export const isQuotaError = (err) => QUOTA_ERROR.test(String(err?.message || err || ''));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createCaptureQueue({
  capture = (windowId, options) => platform.capture.visibleTab(windowId, options),
  minGapMs = MIN_GAP_MS,
  retryDelaysMs = RETRY_DELAYS_MS,
  wait = sleep,
  now = () => Date.now(),
} = {}) {
  let chain = Promise.resolve();
  let lastCall = -Infinity;
  let pending = 0;

  async function attempt(windowId, options) {
    for (let i = 0; ; i++) {
      const gap = lastCall + minGapMs - now();
      if (gap > 0) await wait(gap);
      lastCall = now();
      try {
        return await capture(windowId, options);
      } catch (err) {
        if (!isQuotaError(err) || i >= retryDelaysMs.length) throw err;
        await wait(retryDelaysMs[i]);
      }
    }
  }

  return {
    /** Resolves with the data URL, or rejects after retries are exhausted. */
    capture(windowId, options = { format: 'png' }) {
      pending += 1;
      const run = chain.then(() => attempt(windowId, options));
      chain = run.catch(() => {});
      return run.finally(() => { pending -= 1; });
    },
    get pending() { return pending; },
  };
}

// Shared instance: the live recorder and the one-shot capture use the same budget.
let shared = null;
export function captureVisibleTabQueued(windowId, options) {
  shared ||= createCaptureQueue();
  return shared.capture(windowId, options);
}

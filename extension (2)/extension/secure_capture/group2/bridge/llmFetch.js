// fetch() for LLM APIs that works in every extension context.
//
// Chrome kills the service worker when one of its fetch() calls waits more
// than 30 s, and vision models can take longer. So from the service worker the
// request is run by the offscreen document (LLM_FETCH in offscreen.js), which
// has no such limit. Pages (Options, Guides) and Node tests use fetch directly.
// The body is built and privacy-guarded by the caller; it is sent unchanged.

import { sendToOffscreen } from './offscreenClient.js';

// Only these hosts may be called through the offscreen proxy.
export const LLM_HOSTS = ['generativelanguage.googleapis.com', 'api.groq.com', 'api.mistral.ai'];

export const isAllowedLlmUrl = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && LLM_HOSTS.includes(u.host);
  } catch {
    return false;
  }
};

const inServiceWorker = () => typeof ServiceWorkerGlobalScope !== 'undefined' && globalThis instanceof ServiceWorkerGlobalScope;

async function offscreenFetch(url, init, timeoutMs) {
  const reply = sendToOffscreen('LLM_FETCH', { url, method: init.method || 'GET', headers: init.headers, body: init.body, timeoutMs });
  const res = await new Promise((resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('The request timed out', 'AbortError')), { once: true });
    reply.then(resolve, reject);
  });
  if (!res?.ok) {
    const err = new Error(res?.message || res?.error || 'Offscreen request failed');
    err.name = res?.name === 'AbortError' ? 'AbortError' : (res?.name || 'TypeError');
    throw err;
  }
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    headers: { get: (h) => (String(h).toLowerCase() === 'retry-after' ? res.retryAfter : null) },
    json: async () => JSON.parse(res.text),
    text: async () => res.text,
  };
}

/** Same signature as fetch(url, init). timeoutMs is the offscreen side's own limit. */
export function llmFetch(url, init, { timeoutMs = 120000 } = {}) {
  if (inServiceWorker() && isAllowedLlmUrl(url)) return offscreenFetch(url, init, timeoutMs);
  return fetch(url, init);
}

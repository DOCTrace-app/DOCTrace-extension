import { assertUploadable } from '../privacy/guard.js';
import { blobToWire } from '../bridge/blobCodec.js';
import { platform } from '../platform/platform.js';

const MAX_IMAGE_SIDE = 1600;
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
// Newer Flash models think before answering and can need 30-60 s. Chrome kills
// a service worker whose fetch() waits over 30 s, so from the service worker the
// request goes through the offscreen document (see geminiFetch), which has no
// such limit. Each attempt may take up to 2 minutes.
const ATTEMPT_TIMEOUT_MS = 120000;
const MAX_TIMEOUTS = 2; // a second timeout ends the call (keeps one group under ~4 min)

const geminiFetch = (url, init) => platform.net.fetch(url, init, { timeoutMs: ATTEMPT_TIMEOUT_MS });
const RETRY_DELAYS_MS = [400, 900];
// Free-tier per-minute limits answer "retry in ~30 s": wait for it (up to this) instead of giving up.
const MAX_RATE_LIMIT_WAIT_MS = 65000;
const NETWORK_RETRY_DELAYS_MS = [1500, 4000];

// The browser's own reason for a failed fetch (e.g. "TypeError: Failed to fetch"),
// with the key removed in case it ever appears. Safe to show in the UI.
function networkDetail(error, apiKey) {
  let s = `${error?.name || 'Error'}: ${error?.message || error || 'unknown'}`;
  if (apiKey) s = s.split(apiKey).join('[key]');
  return s.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[key]').slice(0, 160);
}
const DEFAULT_RATE_LIMIT_WAIT_MS = 20000;

export class GeminiRequestError extends Error {
  constructor(code, message, { dailyQuotaExhausted = false } = {}) {
    super(message);
    this.name = 'GeminiRequestError';
    this.code = code;
    this.dailyQuotaExhausted = dailyQuotaExhausted;
  }
}

class GeminiImageError extends Error {}

async function resizeRedactedImage(blob) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
    const longestSide = Math.max(bitmap.width, bitmap.height);
    if (!longestSide) throw new Error('Empty image');
    const scale = Math.min(1, MAX_IMAGE_SIDE / longestSide);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.drawImage(bitmap, 0, 0, width, height);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    if (!jpeg.size || jpeg.type !== 'image/jpeg') throw new Error('JPEG encoding failed');
    return jpeg;
  } catch {
    throw new GeminiImageError('Could not prepare a protected screenshot.');
  } finally {
    bitmap?.close();
  }
}

/** Fetch and encode only frames that pass the upload guard. */
export async function prepareGeminiImages(steps, getStep) {
  const images = [];
  const skippedStepNumbers = [];

  for (const step of steps) {
    const frame = await getStep(step.sessionId, step.stepNumber);
    try {
      assertUploadable(frame);
    } catch {
      skippedStepNumbers.push(step.stepNumber);
      continue;
    }

    try {
      const jpeg = await resizeRedactedImage(frame.redactedBlob);
      const wire = await blobToWire(jpeg);
      images.push({ stepNumber: step.stepNumber, base64: wire.base64 });
    } catch (error) {
      if (!(error instanceof GeminiImageError)) throw error;
      skippedStepNumbers.push(step.stepNumber);
    }
  }

  return { images, skippedStepNumbers };
}

function requestByteLength(body) {
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(body).byteLength : body.length;
}

function retryDelayFromBody(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const delay = retryDelayFromBody(item);
      if (delay !== null) return delay;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (/retry.?delay/i.test(key) && typeof nested === 'string') {
      const match = /([\d.]+)\s*(ms|s)?/i.exec(nested);
      if (match) return Number(match[1]) * (/^ms$/i.test(match[2] || '') ? 1 : 1000);
    }
    const delay = retryDelayFromBody(nested);
    if (delay !== null) return delay;
  }
  return null;
}

async function quotaInfo(response, bodyText) {
  let body = null;
  try { body = JSON.parse(bodyText); } catch { /* The raw body is used only for quota classification. */ }
  const details = JSON.stringify(body || bodyText);
  const daily = /requests.?per.?day|per.?day|daily.{0,20}quota|quota.{0,20}daily/i.test(details);
  const perMinute = /requests.?per.?minute|per.?minute|minute.{0,20}quota|quota.{0,20}minute/i.test(details);
  const retryDelay = retryDelayFromBody(body) ?? (() => {
    const header = Number(response.headers?.get?.('retry-after'));
    return Number.isFinite(header) && header > 0 ? header * 1000 : null;
  })();
  // Google lists the violated quota, e.g. { quotaId: "...PerDay...", quotaValue: "20" }. Numbers only, safe to show.
  const violation = (body?.error?.details || []).flatMap((d) => d?.violations || []).find((v) => v?.quotaValue);
  const limit = Number(violation?.quotaValue);
  const limitNote = Number.isFinite(limit) ? ` (limit: ${limit} requests per day)` : '';
  return { daily, perMinute, retryDelay, limitNote };
}

// Google's machine-readable error codes only (e.g. "INVALID_ARGUMENT / API_KEY_INVALID",
// "NOT_FOUND"). Free-text messages are never shown: they can echo request data.
function googleReason(bodyText) {
  try {
    const err = JSON.parse(bodyText)?.error;
    const codes = [err?.status, ...(Array.isArray(err?.details) ? err.details.map((d) => d?.reason) : [])];
    return codes.filter((c) => typeof c === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(c)).join(' / ');
  } catch {
    return '';
  }
}

function isCompleteJson(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '').trim();
  try { return Array.isArray(JSON.parse(cleaned)?.steps); } catch { return false; }
}

/** Test hook: forget the per-session "lean works better" preference. */
export function resetGeminiPreferences() { preferLean = false; workingModel.clear(); }

function responseText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.map((part) => typeof part.text === 'string' ? part.text : '').join('\n') : '';
}

// Strict output schema (Gemini structured output): every step must have all five parts.
export const STEP_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    steps: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          stepNumber: { type: 'INTEGER' },
          stepTitle: { type: 'STRING' },
          actionInstruction: { type: 'STRING' },
          screenContext: { type: 'STRING' },
          uiLandmarks: { type: 'STRING' },
          expectedOutcome: { type: 'STRING' },
          note: { type: 'STRING' },
        },
        required: ['stepNumber', 'stepTitle', 'actionInstruction', 'screenContext', 'uiLandmarks', 'expectedOutcome'],
        propertyOrdering: ['stepNumber', 'stepTitle', 'actionInstruction', 'screenContext', 'uiLandmarks', 'expectedOutcome', 'note'],
      },
    },
  },
  required: ['steps'],
};
STEP_RESPONSE_SCHEMA.properties.intro = { type: 'STRING' }; // guide introduction (only with a spoken intro)
STEP_RESPONSE_SCHEMA.propertyOrdering = ['intro', 'steps'];

// Tried in order when the configured model is missing (404) or stays overloaded (500/503).
// Both are Google aliases that always point at a current model.
export const FALLBACK_MODEL = 'gemini-flash-latest';
export const MODEL_FALLBACKS = [FALLBACK_MODEL, 'gemini-flash-lite-latest'];
const OVERLOAD_WAIT_MS = 4000;

// configured model -> fallback that worked, so later groups skip the overloaded one.
const workingModel = new Map();

// Set once a strict-schema request timed out or was rejected and the lean one
// worked, so later groups in this session skip straight to what works.
let preferLean = false;

/**
 * strict: responseSchema enforces the five-part JSON.
 * lean:   plain JSON mode (what the first working version used); the prompt
 *         still spells out the five-part format and the parser validates it.
 * Strict + some models can stall until the output limit, so a timeout or 400
 * switches to lean.
 */
function makeRequest(settings, prompt, images, { model = settings.model, lean = false } = {}) {
  const parts = [{ text: prompt.user }];
  for (const image of images) {
    parts.push(
      { text: `Redacted screenshot for step ${image.stepNumber}:` },
      { inlineData: { mimeType: 'image/jpeg', data: image.base64 } },
    );
  }

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: prompt.system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      ...(lean ? {} : { responseSchema: STEP_RESPONSE_SCHEMA }),
      temperature: 0.3,
      // About 200 tokens per five-part step; a tight cap stops a stalled answer early.
      maxOutputTokens: Math.min(4096, 600 + images.length * 500),
    },
  });
  if (requestByteLength(body) > MAX_REQUEST_BYTES) {
    throw new GeminiRequestError('REQUEST_TOO_LARGE', 'Gemini request was too large; templates were used.');
  }
  const base = settings.endpoint.replace(/\/+$/, '');
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
  return { url, body };
}

export async function callGemini(settings, prompt, images, fetchImpl = geminiFetch) {
  if (!settings.enabled || !settings.consent) {
    throw new GeminiRequestError('TEXT_CONSENT_REQUIRED', 'Gemini requires LLM and scrubbed-text consent.');
  }
  if (!settings.imageConsent) {
    throw new GeminiRequestError('IMAGE_CONSENT_REQUIRED', 'Gemini requires separate screenshot consent.');
  }
  if (!settings.apiKey) {
    throw new GeminiRequestError('API_KEY_REQUIRED', 'A Gemini API key is required.');
  }
  if (!Array.isArray(images) || images.length === 0) {
    throw new GeminiRequestError('NO_PROTECTED_IMAGES', 'No protected screenshots were available for Gemini.');
  }

  let model = workingModel.get(settings.model) || settings.model;
  const tried = new Set([model]);
  const nextModel = () => MODEL_FALLBACKS.find((m) => !tried.has(m)) || null;
  let overloads = 0;
  let lean = preferLean;
  let { url, body } = makeRequest(settings, prompt, images, { model, lean });
  const goLean = () => {
    lean = true;
    ({ url, body } = makeRequest(settings, prompt, images, { model, lean }));
  };
  let timeouts = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
    let response;
    let data;
    let errorBody = '';
    let readError = null;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': settings.apiKey,
        },
        body,
        signal: controller.signal,
      });
      if (response.ok) {
        try {
          data = await response.json();
        } catch (error) {
          readError = error;
        }
      } else {
        try {
          errorBody = await response.text();
        } catch (error) {
          readError = error;
        }
      }
    } catch (error) {
      readError = error;
    } finally {
      clearTimeout(timer);
    }

    if (readError) {
      if (readError.name === 'AbortError') timeouts += 1;
      if (readError.name === 'AbortError' && timeouts < MAX_TIMEOUTS && attempt < 2) {
        if (!lean) goLean(); // a stalled strict-schema answer: retry in plain JSON mode
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      if (readError.name === 'AbortError') {
        throw new GeminiRequestError('TIMEOUT', `Gemini did not answer within ${ATTEMPT_TIMEOUT_MS / 1000} s, ${timeouts} times (model ${model}); templates were used.`);
      }
      if (response?.ok) {
        throw new GeminiRequestError('INVALID_RESPONSE', 'Gemini returned an unreadable response.');
      }
      if (response) {
        throw new GeminiRequestError('INVALID_ERROR_RESPONSE', 'Gemini returned an unreadable error response.');
      }
      // No response at all (connection dropped, reset, blocked by a proxy/antivirus/VPN).
      // Often transient, so retry before giving up.
      const detail = networkDetail(readError, settings.apiKey);
      console.warn(`DOCTrace: Gemini network error on attempt ${attempt + 1}/3 (model ${model})`, detail);
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, NETWORK_RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw new GeminiRequestError('NETWORK_ERROR', `Gemini request failed with no response after 3 tries (${detail}). Check for a VPN, proxy or antivirus blocking generativelanguage.googleapis.com, then try again.`);
    }

    if (response.ok) {
      const text = responseText(data);
      const cutOff = data?.candidates?.[0]?.finishReason === 'MAX_TOKENS' || !text.trim();
      if (!lean && cutOff && attempt < 2) {
        goLean(); // stalled until the output limit, or empty: retry in plain JSON mode
        continue;
      }
      if (lean && !preferLean && isCompleteJson(text)) preferLean = true;
      if (model !== settings.model) workingModel.set(settings.model, model);
      return text;
    }

    if (response.status === 429) {
      const quota = await quotaInfo(response, errorBody);
      if (quota.daily) {
        // Daily limits are per model: another current Flash model may still have requests left.
        const next = nextModel();
        if (next) {
          console.warn(`DOCTrace: daily Gemini quota used up for ${model}; trying ${next}`);
          model = next;
          tried.add(model);
          ({ url, body } = makeRequest(settings, prompt, images, { model, lean }));
          attempt--;
          continue;
        }
        throw new GeminiRequestError('DAILY_QUOTA',
          `Gemini's daily free-tier limit is used up for ${[...tried].join(' and ')}${quota.limitNote}. It resets at midnight Pacific time; templates were used until then.`,
          { dailyQuotaExhausted: true });
      }
      const wait = quota.retryDelay ?? DEFAULT_RATE_LIMIT_WAIT_MS;
      if (attempt < 2 && wait <= MAX_RATE_LIMIT_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(wait, RETRY_DELAYS_MS[attempt])));
        continue;
      }
      throw new GeminiRequestError('RATE_LIMITED', 'Gemini rate limit reached; templates were used for this group.');
    }

    // Self-healing below; each model is tried at most twice, so the loop always ends.
    // (attempt-- keeps the retry budget for the new model.)
    if (response.status === 500 || response.status === 503) {
      overloads += 1;
      if (overloads === 1) {
        await new Promise((resolve) => setTimeout(resolve, OVERLOAD_WAIT_MS)); // give it a moment
        attempt--;
        continue;
      }
      const next = nextModel();
      if (next) {
        console.warn(`DOCTrace: ${model} is overloaded (HTTP ${response.status}); trying ${next}`);
        model = next; // still overloaded: switch to another current Flash model
        tried.add(model);
        overloads = 0;
        ({ url, body } = makeRequest(settings, prompt, images, { model, lean }));
        attempt--;
        continue;
      }
      throw new GeminiRequestError('OVERLOADED', `Gemini is overloaded (HTTP ${response.status}) on ${[...tried].join(' and ')}; templates were used. Try again in a few minutes.`);
    }
    if (response.status === 404) {
      const next = nextModel();
      if (next) {
        model = next; // the configured model was renamed or retired
        tried.add(model);
        ({ url, body } = makeRequest(settings, prompt, images, { model, lean }));
        attempt--;
        continue;
      }
    }
    if (response.status === 400 && !lean) {
      goLean(); // this model rejected the strict schema
      attempt--;
      continue;
    }
    const reason = googleReason(errorBody);
    const modelNote = response.status === 404 ? ` for model '${model}'` : '';
    throw new GeminiRequestError('HTTP_ERROR', `Gemini request failed (HTTP ${response.status})${modelNote}${reason ? ` - ${reason}` : ''}; templates were used.`);
  }

  throw new GeminiRequestError('REQUEST_FAILED', 'Gemini request failed; templates were used.');
}

/**
 * Run groups (up to `concurrency` at once, started in order) and stop network
 * calls after a daily quota error: groups not started yet are skipped.
 */
export async function runGeminiGroups(groups, processGroup, onGroup, { initiallyExhausted = false, onDailyQuota = async () => {}, concurrency = 1 } = {}) {
  let dailyQuotaExhausted = initiallyExhausted;
  let nextIndex = 0;

  const runOne = async (group) => {
    if (dailyQuotaExhausted) {
      await onGroup(group, { results: new Map(), skipped: true, error: null });
      return;
    }
    try {
      const result = await processGroup(group);
      await onGroup(group, { ...result, error: null, skipped: false });
    } catch (error) {
      const isDailyQuota = error instanceof GeminiRequestError && error.dailyQuotaExhausted;
      if (isDailyQuota && !dailyQuotaExhausted) {
        dailyQuotaExhausted = true;
        await onDailyQuota();
      }
      await onGroup(group, { results: new Map(), skipped: false, error });
    }
  };

  const lane = async () => {
    while (nextIndex < groups.length) await runOne(groups[nextIndex++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, groups.length)) }, lane));

  return { dailyQuotaExhausted };
}

// Vision descriptions through an OpenAI-style /chat/completions API
// (Groq, Mistral; later a local Ollama vision model works the same way).
//
// Only what the manual generator already guarded is sent: the scrubbed text
// prompt and REDACTED screenshots (prepared by prepareGeminiImages, which runs
// the upload guard). Raw screenshots never reach this file.

import { platform } from '../platform/platform.js';
import { GeminiRequestError as LlmRequestError } from './geminiClient.js';

const ATTEMPT_TIMEOUT_MS = 120000;
const MAX_RATE_LIMIT_WAIT_MS = 65000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 15000;
const SERVER_ERROR_WAIT_MS = 3000;
const NETWORK_RETRY_DELAYS_MS = [1500, 4000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clean(text, apiKey) {
  let s = String(text || '');
  if (apiKey) s = s.split(apiKey).join('[key]');
  return s.replace(/(gsk|sk)_[A-Za-z0-9]{16,}/g, '[key]').slice(0, 160);
}

// Machine-readable codes only ("model_not_found", "invalid_api_key"); free text can echo the request.
function errorCode(bodyText) {
  try {
    const e = JSON.parse(bodyText)?.error;
    return [e?.code, e?.type].filter((c) => typeof c === 'string' && /^[a-z][a-z0-9_]{1,60}$/i.test(c)).join(' / ');
  } catch {
    return '';
  }
}

function retryAfterMs(response) {
  const v = Number(response.headers?.get?.('retry-after'));
  return Number.isFinite(v) && v > 0 ? v * 1000 : null;
}

export function buildVisionBody(settings, prompt, images, { jsonMode = true } = {}) {
  const content = [{ type: 'text', text: prompt.user }];
  for (const image of images) {
    content.push(
      { type: 'text', text: `Redacted screenshot for step ${image.stepNumber}:` },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.base64}` } },
    );
  }
  return JSON.stringify({
    model: settings.model,
    temperature: 0.3,
    // Groq counts max_tokens against the free tier's tokens-per-minute limit, so ask only for
    // what a five-part step needs (~250 tokens each).
    max_tokens: Math.min(4096, 400 + images.length * 500), // narrated steps are longer
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content },
    ],
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  });
}

// ---------- model discovery ----------
// Providers retire models often (Groq returned model_not_found for Llama 4 Scout).
// When the configured model is gone or cannot take images, ask the provider for
// its current models and try the ones whose names suggest image input.
// Known image models first (Groq: qwen3.x multimodal), then name patterns. Text-only
// models that slip through answer 400 and are skipped.
const VISION_HINTS = [/qwen3\.\d+-\d+b/, /muse/, /[-_]vl\b|[-_]vl[-_]/, /vision/, /llama-4/, /pixtral/, /llava/, /gemma-?3/, /mistral-(small|medium)/, /multimodal|omni/, /qwen/];
const NOT_CHAT = /whisper|tts|speech|audio|guard|embed|moderation|rerank|transcri|playai|orpheus/;
const MAX_CANDIDATES = 4;

const workingModel = new Map(); // `${endpoint}|${configured model}` -> model that worked
export const getWorkingVisionModel = (settings) => workingModel.get(`${settings.endpoint}|${settings.model}`) || null;
export function resetVisionPreferences() { workingModel.clear(); }

export function rankVisionModels(ids) {
  return ids
    .filter((id) => typeof id === 'string' && !NOT_CHAT.test(id.toLowerCase()))
    .map((id) => ({ id, rank: VISION_HINTS.findIndex((re) => re.test(id.toLowerCase())) }))
    .filter((m) => m.rank >= 0)
    .sort((a, b) => a.rank - b.rank || b.id.localeCompare(a.id)) // newest-looking names first within a hint
    .map((m) => m.id);
}

async function listModels(settings, fetchImpl) {
  const url = settings.endpoint.replace(/\/chat\/completions\/?$/, '/models');
  try {
    const res = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${settings.apiKey}` } });
    if (!res.ok) return [];
    const data = JSON.parse(await res.text());
    return (data?.data || []).filter((m) => m?.active !== false).map((m) => m?.id);
  } catch {
    return [];
  }
}

/** @returns {Promise<string>} the model's text answer (JSON with a "steps" list). */
export async function callOpenAIVision(settings, prompt, images, fetchImpl = (u, i) => platform.net.fetch(u, i, { timeoutMs: ATTEMPT_TIMEOUT_MS })) {
  const name = settings.providerLabel || 'The vision provider';
  if (!settings.enabled || !settings.consent || !settings.imageConsent) {
    throw new LlmRequestError('CONSENT_REQUIRED', `${name} needs text consent and separate screenshot consent.`);
  }
  if (!settings.apiKey) throw new LlmRequestError('API_KEY_REQUIRED', `An API key is required for ${name}.`);
  if (!Array.isArray(images) || images.length === 0) {
    throw new LlmRequestError('NO_PROTECTED_IMAGES', 'No protected screenshots were available.');
  }

  const cacheKey = `${settings.endpoint}|${settings.model}`;
  const first = workingModel.get(cacheKey) || settings.model;
  const tried = [first];
  try {
    return await requestWithModel(settings, first, prompt, images, fetchImpl, name);
  } catch (err) {
    if (!['MODEL_NOT_FOUND', 'MODEL_REJECTED'].includes(err?.code)) throw err;
    const candidates = rankVisionModels(await listModels(settings, fetchImpl)).filter((m) => !tried.includes(m)).slice(0, MAX_CANDIDATES);
    let lastErr = err;
    for (const model of candidates) {
      tried.push(model);
      console.warn(`DOCTrace: ${name} model '${tried[tried.length - 2]}' unavailable; trying '${model}'`);
      try {
        const text = await requestWithModel(settings, model, prompt, images, fetchImpl, name);
        workingModel.set(cacheKey, model);
        return text;
      } catch (e) {
        if (!['MODEL_NOT_FOUND', 'MODEL_REJECTED'].includes(e?.code)) throw e;
        lastErr = e;
      }
    }
    throw new LlmRequestError('MODEL_NOT_FOUND',
      `${name} has no working image model${candidates.length ? ` (tried ${tried.join(', ')})` : ` ('${first}' is unavailable)`}. ${lastErr.message}`);
  }
}

async function requestWithModel(baseSettings, model, prompt, images, fetchImpl, name) {
  const settings = { ...baseSettings, model };
  let jsonMode = true;
  let rateLimitWaits = 0;
  let body = buildVisionBody(settings, prompt, images, { jsonMode });
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
    let response;
    let text = '';
    try {
      response = await fetchImpl(settings.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
        body,
        signal: controller.signal,
      });
      text = await response.text();
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') {
        if (attempt < 2) continue;
        throw new LlmRequestError('TIMEOUT', `${name} did not answer within ${ATTEMPT_TIMEOUT_MS / 1000} s; templates were used.`);
      }
      console.warn(`DOCTrace: ${name} network error on attempt ${attempt + 1}/3`, clean(err?.message, settings.apiKey));
      if (attempt < 2) { await sleep(NETWORK_RETRY_DELAYS_MS[attempt]); continue; }
      throw new LlmRequestError('NETWORK_ERROR', `${name} request failed with no response after 3 tries (${clean(`${err?.name}: ${err?.message}`, settings.apiKey)}).`);
    }
    clearTimeout(timer);

    if (response.ok) {
      let data;
      try { data = JSON.parse(text); } catch { throw new LlmRequestError('INVALID_RESPONSE', `${name} returned an unreadable response.`); }
      const choice = data?.choices?.[0];
      const content = choice?.message?.content;
      const answer = Array.isArray(content) ? content.map((p) => p?.text || '').join('\n') : String(content || '');
      // Reasoning models (e.g. Qwen3) may put their thinking before the JSON.
      return answer.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').trim();
    }

    // Per-minute limits clear within a minute: wait them out (up to 5 times) instead of giving up.
    if (response.status === 429 && rateLimitWaits < 5) {
      const wait = retryAfterMs(response) ?? DEFAULT_RATE_LIMIT_WAIT_MS;
      if (wait <= MAX_RATE_LIMIT_WAIT_MS) { rateLimitWaits += 1; await sleep(wait); attempt--; continue; }
    }
    if (response.status === 429) {
      throw new LlmRequestError('RATE_LIMITED', `${name} rate limit reached; templates were used. Try again in a few minutes.`);
    }
    if (response.status >= 500 && attempt < 2) { await sleep(SERVER_ERROR_WAIT_MS); continue; }
    if (response.status === 400 && jsonMode) {
      jsonMode = false; // some models reject JSON mode together with images; the prompt still asks for JSON
      body = buildVisionBody(settings, prompt, images, { jsonMode });
      attempt--;
      continue;
    }
    const code = errorCode(text);
    const detail = `${name} request failed for model '${model}' (HTTP ${response.status})${code ? ` - ${code}` : ''}`;
    if (response.status === 413) {
      // One request is bigger than the per-minute token allowance: retrying the same
      // request can never work. The manual generator splits the group and tries again.
      throw new LlmRequestError('REQUEST_TOO_LARGE', `${detail}: one request is over ${name}'s per-minute token limit.`);
    }
    if (response.status === 404 || /model_(not_found|decommissioned)|model_not_active/.test(code)) {
      throw new LlmRequestError('MODEL_NOT_FOUND', `${detail}.`);
    }
    if (response.status === 400) {
      throw new LlmRequestError('MODEL_REJECTED', `${detail}; it may not accept images.`); // even without JSON mode
    }
    const hint = response.status === 401 || response.status === 403 ? ' Check the API key.' : '';
    throw new LlmRequestError('HTTP_ERROR', `${detail};${hint} templates were used.`);
  }
  throw new LlmRequestError('REQUEST_FAILED', `${name} request failed; templates were used.`);
}

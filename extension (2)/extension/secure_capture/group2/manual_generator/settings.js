// Manual generator settings, kept in the platform key-value store
// (chrome.storage.local in the extension; see platform/platform.js). Set on the Options page.
//
// The LLM is OFF by default. Vision providers (Groq, Mistral, Gemini) receive
// redacted screenshots, so they additionally require separate image consent.
// Consent is tied to the provider it was given for: switching provider asks again.
// Each provider keeps its own API key, so a key is never sent to another service.
// A local OpenAI-compatible endpoint (Ollama, LM Studio) keeps text on-device.
// Note: API keys are stored unencrypted in chrome.storage.local (prototype).

import { platform } from '../platform/platform.js';

export const SETTINGS_KEY = 'docTraceManualSettings';
const LEGACY_SETTINGS_KEY = 'scManualSettings'; // pre-DOCTrace name; migrated on first load
const RETIRED_GEMINI_DEFAULTS = new Set(['gemini-2.5-flash']);

// vision: sends redacted screenshots. maxImages: provider limit per request.
// kind: which client talks to it ('openai' = OpenAI-style /chat/completions).
export const PROVIDERS = {
  groq: {
    // Groq's vision docs (Nov 2026): qwen/qwen3.8-27b is the generally available image model, 3 images per request.
    label: 'Groq (free, vision)', short: 'Groq', kind: 'openai', vision: true, maxImages: 3, needsKey: true,
    endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'qwen/qwen3.8-27b',
    keyHint: 'Paste your Groq API key (console.groq.com/keys)',
  },
  mistral: {
    label: 'Mistral (free tier, vision)', short: 'Mistral', kind: 'openai', vision: true, maxImages: 8, needsKey: true,
    endpoint: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest',
    keyHint: 'Paste your Mistral API key (console.mistral.ai)',
  },
  gemini: {
    label: 'Google Gemini API (vision)', short: 'Gemini', kind: 'gemini', vision: true, maxImages: 8, needsKey: true,
    endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-flash-latest',
    keyHint: 'Paste your Google AI Studio API key',
  },
  anthropic: {
    label: 'Anthropic Claude API (text only)', short: 'Claude', kind: 'anthropic', vision: false, needsKey: true,
    endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-haiku-4-5-20251001',
    keyHint: 'Paste your Anthropic API key',
  },
  openai: {
    label: 'OpenAI-compatible (OpenAI, Ollama, LM Studio; text only)', short: 'The endpoint', kind: 'openai', vision: false, needsKey: false,
    endpoint: 'http://localhost:11434/v1/chat/completions', model: 'llama3.1',
    keyHint: 'Not needed for a local endpoint',
  },
};

export const isVisionProvider = (s) => Boolean(PROVIDERS[s?.provider]?.vision);

export const DEFAULT_SETTINGS = {
  enabled: false,
  consent: false,
  imageConsent: false,
  consentFor: null,       // provider the consent boxes were ticked for
  provider: 'groq',
  endpoint: PROVIDERS.groq.endpoint,
  model: PROVIDERS.groq.model,
  apiKey: '',             // key of the CURRENT provider (filled from apiKeys)
  apiKeys: {},            // provider -> its own key
  mode: 'batch',          // 'realtime': one request per step while recording; 'batch': after recording; 'off': manual only.
  stepsPerCall: 20,
  geminiStepsPerCall: 6,  // screenshots per vision request (capped by the provider's maxImages)
  llmConcurrency: 2,      // vision requests sent at the same time (parallel generation)
  learnedPerRequest: {},  // provider -> screenshots per request it accepted (set after an HTTP 413)
  timeoutMs: 60000,
};

export async function loadSettings() {
  const data = await platform.kv.get([SETTINGS_KEY, LEGACY_SETTINGS_KEY]);
  let saved = data[SETTINGS_KEY];
  if (!saved && data[LEGACY_SETTINGS_KEY]) {
    // Carry settings (including the API key) over from the old name, then drop the old copy.
    saved = data[LEGACY_SETTINGS_KEY];
    await platform.kv.set({ [SETTINGS_KEY]: saved });
    await platform.kv.remove(LEGACY_SETTINGS_KEY);
  }
  return normalize(saved || {});
}

/** Fill per-provider keys and consent from older saved shapes. Pure: also used by tests. */
export function normalize(saved) {
  const s = { ...DEFAULT_SETTINGS, ...saved };
  if (!PROVIDERS[s.provider]) s.provider = DEFAULT_SETTINGS.provider;
  const apiKeys = { ...(saved.apiKeys || {}) };
  // Older settings had one apiKey: it belongs to the provider it was saved with.
  // Only for that old shape (no apiKeys map yet), so a stale key never moves to another provider.
  if (!saved.apiKeys && saved.apiKey && saved.provider) apiKeys[saved.provider] = saved.apiKey;
  s.apiKeys = apiKeys;
  s.apiKey = apiKeys[s.provider] || '';
  const consentFor = saved.consentFor ?? (saved.consent ? saved.provider : null);
  if (consentFor !== s.provider) { s.consent = false; s.imageConsent = false; }
  s.consentFor = consentFor === s.provider ? consentFor : null;
  // gemini-2.5-flash was briefly the default but is retired for new keys (HTTP 404).
  if (s.provider === 'gemini' && RETIRED_GEMINI_DEFAULTS.has(s.model)) s.model = PROVIDERS.gemini.model;
  // Llama 4 Scout was retired by Groq (model_not_found).
  if (s.provider === 'groq' && /llama-4-scout/.test(s.model || '')) s.model = PROVIDERS.groq.model;
  return s;
}

export async function saveSettings(settings) {
  const prev = await loadSettings().catch(() => normalize({}));
  const apiKeys = { ...(prev.apiKeys || {}), ...(settings.apiKeys || {}) };
  if (settings.provider) apiKeys[settings.provider] = settings.apiKey || '';
  const clean = {
    ...DEFAULT_SETTINGS,
    ...settings,
    apiKeys,
    consentFor: settings.consent ? settings.provider : null,
  };
  delete clean.apiKey; // keys live only in apiKeys
  await platform.kv.set({ [SETTINGS_KEY]: clean });
  return normalize(clean);
}

/** Save a model that was discovered to work, if that provider is still the selected one. */
export async function rememberModel(provider, model) {
  if (!platform.kv.available?.() || !provider || !model) return;
  const data = await platform.kv.get(SETTINGS_KEY);
  const saved = data[SETTINGS_KEY];
  if (!saved || saved.provider !== provider || saved.model === model) return;
  await platform.kv.set({ [SETTINGS_KEY]: { ...saved, model } });
}

/**
 * A provider said one request was too large (Groq free tier, HTTP 413): remember
 * the size that is allowed, so the next guide does not waste a request on it.
 */
export async function rememberPerRequest(provider, perRequest) {
  if (!platform.kv.available?.() || !provider || !(perRequest >= 1)) return;
  const data = await platform.kv.get(SETTINGS_KEY);
  const saved = data[SETTINGS_KEY];
  if (!saved) return;
  const learned = { ...(saved.learnedPerRequest || {}) };
  if (learned[provider] && learned[provider] <= perRequest) return;
  learned[provider] = perRequest;
  await platform.kv.set({ [SETTINGS_KEY]: { ...saved, learnedPerRequest: learned } });
}

export const llmReady = (s) => Boolean(
  s.enabled
  && s.consent
  && s.endpoint
  && s.model
  && PROVIDERS[s.provider]
  && (!isVisionProvider(s) || s.imageConsent)
  && (s.apiKey || !PROVIDERS[s.provider].needsKey),
);

// OpenAI-style vision client (Groq, Mistral) and per-provider settings. Run: node --test vision.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { callOpenAIVision, buildVisionBody, rankVisionModels, getWorkingVisionModel, resetVisionPreferences } from '../../manual_generator/visionClient.js';
import { normalize, llmReady, isVisionProvider, PROVIDERS } from '../../manual_generator/settings.js';

const settings = {
  enabled: true, consent: true, imageConsent: true, provider: 'groq', providerLabel: 'Groq',
  endpoint: PROVIDERS.groq.endpoint, model: PROVIDERS.groq.model, apiKey: 'gsk_testkey1234567890abcd',
};
const prompt = { system: 'sys', user: 'Describe step 1.' };
const images = [{ stepNumber: 1, base64: 'AQID' }];
const ok = (content) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) });
const fail = (status, body = '{"error":{"code":"bad_thing"}}', retryAfter = null) => ({ ok: false, status, headers: { get: (h) => (h === 'retry-after' ? retryAfter : null) }, text: async () => body });

test('sends redacted images as data URLs with a Bearer key, returns the answer', async () => {
  let seen;
  const text = await callOpenAIVision(settings, prompt, images, async (url, init) => { seen = { url, init }; return ok('{"steps":[]}'); });
  assert.equal(text, '{"steps":[]}');
  assert.equal(seen.url, PROVIDERS.groq.endpoint);
  assert.equal(seen.init.headers.authorization, `Bearer ${settings.apiKey}`);
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, PROVIDERS.groq.model);
  assert.equal(body.messages[0].content, 'sys');
  const img = body.messages[1].content.find((p) => p.type === 'image_url');
  assert.equal(img.image_url.url, 'data:image/jpeg;base64,AQID');
  assert.deepEqual(body.response_format, { type: 'json_object' });
});

test('a 400 retries once without JSON mode', async () => {
  const modes = [];
  await callOpenAIVision(settings, prompt, images, async (url, init) => {
    modes.push(Boolean(JSON.parse(init.body).response_format));
    return modes.length === 1 ? fail(400) : ok('{"steps":[]}');
  });
  assert.deepEqual(modes, [true, false]);
});

test('a 429 waits for retry-after, then succeeds', async () => {
  let n = 0;
  const text = await callOpenAIVision(settings, prompt, images, async () => (++n === 1 ? fail(429, '{}', '0.01') : ok('done')));
  assert.equal(text, 'done');
});

test('errors never include the key and point at the fix', async () => {
  await assert.rejects(
    callOpenAIVision(settings, prompt, images, async () => fail(401, `{"error":{"code":"invalid_api_key","message":"bad ${settings.apiKey}"}}`)),
    (e) => !e.message.includes(settings.apiKey) && /401/.test(e.message) && /invalid_api_key/.test(e.message) && /API key/.test(e.message),
  );
});

test('refuses without screenshot consent and sends nothing', async () => {
  let calls = 0;
  await assert.rejects(callOpenAIVision({ ...settings, imageConsent: false }, prompt, images, async () => { calls++; return ok(''); }));
  assert.equal(calls, 0);
});

test('body size scales with images', () => {
  const b = JSON.parse(buildVisionBody(settings, prompt, [1, 2, 3].map((n) => ({ stepNumber: n, base64: 'AQID' }))));
  assert.equal(b.messages[1].content.filter((p) => p.type === 'image_url').length, 3);
  assert.equal(b.max_tokens, 1900);
});

test('old single apiKey stays with its provider; switching provider needs new key and consent', () => {
  const old = normalize({ provider: 'gemini', apiKey: 'AIzaOLD', consent: true, imageConsent: true, enabled: true });
  assert.equal(old.apiKey, 'AIzaOLD');
  assert.equal(old.consent, true);
  const switched = normalize({ ...old, provider: 'groq' });
  assert.equal(switched.apiKey, '');            // the Gemini key is never sent to Groq
  assert.equal(switched.consent, false);         // consent was given for Gemini only
  assert.equal(switched.apiKeys.gemini, 'AIzaOLD');
  assert.equal(llmReady(switched), false);
  assert.equal(isVisionProvider({ provider: 'groq' }), true);
  assert.equal(isVisionProvider({ provider: 'anthropic' }), false);
});

test('a retired model is replaced by a vision model from the provider list', async () => {
  resetVisionPreferences();
  const calls = [];
  const text = await callOpenAIVision(settings, prompt, images, async (url, init) => {
    if (init.method === 'GET') {
      calls.push('list');
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: [
        { id: 'whisper-large-v3' }, { id: 'llama-3.3-70b-versatile' }, { id: 'meta-llama/llama-4-maverick-17b-128e-instruct' }, { id: 'old-vision', active: false },
      ] }) };
    }
    const model = JSON.parse(init.body).model;
    calls.push(model);
    return model === settings.model ? fail(404, '{"error":{"code":"model_not_found","type":"invalid_request_error"}}') : ok('{"steps":[]}');
  });
  assert.equal(text, '{"steps":[]}');
  assert.deepEqual(calls, [settings.model, 'list', 'meta-llama/llama-4-maverick-17b-128e-instruct']);
  assert.equal(getWorkingVisionModel(settings), 'meta-llama/llama-4-maverick-17b-128e-instruct');
  resetVisionPreferences();
});

test('vision ranking skips audio/guard models and text-only names', () => {
  assert.deepEqual(rankVisionModels(['whisper-large-v3', 'llama-guard-4-12b', 'qwen2.5-vl-7b', 'llama-3.1-8b-instant', 'llama-4-scout-x']), ['qwen2.5-vl-7b', 'llama-4-scout-x']);
});

test('Groq defaults to qwen3.8 with 3 images; retired Scout setting is replaced; think tags stripped', async () => {
  assert.equal(PROVIDERS.groq.model, 'qwen/qwen3.8-27b');
  assert.equal(PROVIDERS.groq.maxImages, 3);
  const s = normalize({ provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', apiKeys: { groq: 'gsk_x' } });
  assert.equal(s.model, 'qwen/qwen3.8-27b');
  assert.deepEqual(rankVisionModels(['qwen/qwen3-32b', 'llama-3.3-70b-versatile', 'qwen/qwen3.8-27b'])[0], 'qwen/qwen3.8-27b');
  const text = await callOpenAIVision(settings, prompt, images, async () => ok('<think>let me {look}</think>\n{"steps":[]}'));
  assert.equal(text, '{"steps":[]}');
});

test('HTTP 413 (request over the token limit) is reported as REQUEST_TOO_LARGE, not retried', async () => {
  resetVisionPreferences();
  let calls = 0;
  await assert.rejects(
    callOpenAIVision(settings, prompt, images, async () => { calls++; return fail(413, '{"error":{"code":"rate_limit_exceeded","type":"tokens"}}'); }),
    (e) => e.code === 'REQUEST_TOO_LARGE',
  );
  assert.equal(calls, 1);
  assert.equal(JSON.parse(buildVisionBody(settings, prompt, images)).max_tokens, 900);
});

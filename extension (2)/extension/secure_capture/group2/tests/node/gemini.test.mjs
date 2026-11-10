import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SensitiveClassifier } from '../../detection/mlClassifier.js';
import { GeminiRequestError, callGemini, prepareGeminiImages, runGeminiGroups } from '../../manual_generator/geminiClient.js';
import { isManualStepEligible, reconcileManualDescriptions } from '../../manual_generator/manualGenerator.js';

const model = JSON.parse(readFileSync(new URL('../../model/sensitive_model.json', import.meta.url)));
const classifier = new SensitiveClassifier(model);
const settings = {
  enabled: true,
  consent: true,
  imageConsent: true,
  provider: 'gemini',
  endpoint: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-2.5-flash',
  apiKey: 'test-secret-key',
};
const prompt = { system: 'Describe the screen.', user: 'Step 1: click Settings.' };
const context = (stepNumber) => ({
  stepNumber,
  actionType: 'click',
  targetLabel: 'Settings',
  textUnderClick: 'Settings',
  textNearClick: 'Dashboard',
  clickArea: 'top-left of the screen',
  clickedHiddenField: false,
  hiddenDataOnScreen: [],
  urlPath: 'example.test/settings',
  scrubbedOcrText: 'Dashboard Settings',
});

function response(status, data = {}, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => data,
    text: async () => typeof data === 'string' ? data : JSON.stringify(data),
  };
}

test('maps Gemini descriptions by step number, not response order', () => {
  const { results, fallback } = reconcileManualDescriptions(
    [context(1), context(2)],
    JSON.stringify({ steps: [
      { stepNumber: 2, title: 'Review settings', instruction: 'Review the settings screen.' },
      { stepNumber: 1, title: 'Open settings', instruction: 'Open the settings screen.' },
    ] }),
    classifier,
  );
  assert.equal(results.get(1).instruction, 'Open the settings screen.');
  assert.equal(results.get(2).instruction, 'Review the settings screen.');
  assert.equal(fallback.size, 0);
});

test('falls back only for a step omitted by Gemini', () => {
  const { results, fallback } = reconcileManualDescriptions(
    [context(1), context(2)],
    JSON.stringify({ steps: [{ stepNumber: 2, title: 'Review settings', instruction: 'Review the settings screen.' }] }),
    classifier,
  );
  assert.equal(results.size, 1);
  assert.equal(results.has(2), true);
  assert.equal(fallback.size, 1);
  assert.match(fallback.get(1).instruction, /Settings/);
});

test('force regenerates generated descriptions but never user-authored steps', () => {
  const step = (descriptionSource) => ({ status: 'redacted', descriptionSource });
  assert.equal(isManualStepEligible(step('llm')), false);
  assert.equal(isManualStepEligible(step('template')), true);
  assert.equal(isManualStepEligible(step('llm'), true), true);
  assert.equal(isManualStepEligible(step('template'), true), true);
  assert.equal(isManualStepEligible(step('user'), true), false);
});

test('retries a 503 once and succeeds', async () => {
  let calls = 0;
  const answer = await callGemini(settings, prompt, [{ stepNumber: 1, base64: 'AQID' }], async () => {
    calls += 1;
    return calls === 1
      ? response(503, { error: { message: 'overloaded' } })
      : response(200, { candidates: [{ content: { parts: [{ text: '{"steps":[]}' }] } }] });
  });
  assert.equal(calls, 2);
  assert.equal(answer, '{"steps":[]}');
});

test('daily quota stops requests for the remaining groups', async () => {
  let calls = 0;
  const outputs = [];
  const result = await runGeminiGroups(
    [[1], [2], [3]],
    async () => {
      calls += 1;
      await callGemini(settings, prompt, [{ stepNumber: 1, base64: 'AQID' }], async () => response(429, {
        error: {
          code: 429,
          message: 'Quota exhausted.',
          details: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
        },
      }));
    },
    (group, outcome) => outputs.push({ group, ...outcome }),
  );
  assert.equal(calls, 1);
  assert.equal(result.dailyQuotaExhausted, true);
  assert.equal(outputs.length, 3);
  assert.equal(outputs[1].skipped, true);
  assert.equal(outputs[2].skipped, true);
});

test('a non-redacted step is rejected before its image is encoded', async () => {
  let decodedImages = 0;
  let canvasSize;
  const storedBlob = new Blob(['stored'], { type: 'image/png' });
  globalThis.createImageBitmap = async (blob) => {
    assert.equal(blob, storedBlob);
    decodedImages += 1;
    return { width: 2000, height: 1000, close() {} };
  };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; canvasSize = [width, height]; }
    getContext() { return { drawImage() {} }; }
    async convertToBlob(options) {
      assert.equal(options.type, 'image/jpeg');
      return new Blob(['jpeg-copy'], { type: 'image/jpeg' });
    }
  };

  const { images, skippedStepNumbers } = await prepareGeminiImages(
    [{ sessionId: 's1', stepNumber: 1 }, { sessionId: 's1', stepNumber: 2 }],
    async (_sessionId, stepNumber) => ({
      sessionId: 's1',
      stepNumber,
      status: stepNumber === 1 ? 'redacted' : 'raw',
      redactedBlob: storedBlob,
      piiRegions: [],
    }),
  );
  assert.deepEqual(images.map((image) => image.stepNumber), [1]);
  assert.deepEqual(skippedStepNumbers, [2]);
  assert.equal(decodedImages, 1);
  assert.deepEqual(canvasSize, [1600, 800]);
  assert.equal(storedBlob.type, 'image/png');
  assert.equal(await storedBlob.text(), 'stored');
});

test('Gemini is blocked without separate image consent', async () => {
  let calls = 0;
  await assert.rejects(
    callGemini({ ...settings, imageConsent: false }, prompt, [{ stepNumber: 1, base64: 'AQID' }], async () => {
      calls += 1;
      return response(200);
    }),
    (error) => error.code === 'IMAGE_CONSENT_REQUIRED',
  );
  assert.equal(calls, 0);
});

test('API key stays in the header, not URL or error text', async () => {
  let capturedUrl;
  let capturedInit;
  await assert.rejects(
    callGemini(settings, prompt, [{ stepNumber: 1, base64: 'private-image-data' }], async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return response(400, { error: { message: `bad key ${settings.apiKey} and private-image-data` } });
    }),
    (error) => !error.message.includes(settings.apiKey) && !error.message.includes('private-image-data'),
  );
  assert.equal(capturedUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(capturedUrl.includes(settings.apiKey), false);
  assert.equal(capturedInit.headers['x-goog-api-key'], settings.apiKey);
  const request = JSON.parse(capturedInit.body);
  assert.equal(request.generationConfig.responseMimeType, 'application/json');
  assert.equal(request.systemInstruction.parts[0].text, prompt.system);
  assert.match(request.contents[0].parts[1].text, /step 1/);
  assert.equal(request.contents[0].parts[2].inlineData.data, 'private-image-data');
});

// Capture queue, context and prompt tests for the DOCTrace changes. Run: node --test capture.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptureQueue, isQuotaError } from '../../recorder/captureQueue.js';
import { buildStepContext, templateDescription, urlPathOf, parseManualResponse } from '../../manual_generator/manualGenerator.js';
import { callGemini, STEP_RESPONSE_SCHEMA } from '../../manual_generator/geminiClient.js';
import { manualMarkdown } from '../../storage/exportZip.js';
import { SYSTEM_PROMPT, VISION_SYSTEM_PROMPT, STYLE_EXAMPLE } from '../../manual_generator/prompts.js';
import { PROVIDERS } from '../../manual_generator/settings.js';

// A fake clock: wait() advances time instantly, so tests are fast and exact.
function fakeClock() {
  let t = 0;
  return { now: () => t, wait: async (ms) => { t += ms; } };
}

const QUOTA = new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');

test('captures are spaced by at least minGapMs and stay in click order', async () => {
  const clock = fakeClock();
  const calls = [];
  const q = createCaptureQueue({ ...clock, minGapMs: 500, capture: async (w) => { calls.push({ w, t: clock.now() }); return `img-${w}`; } });
  const results = await Promise.all([1, 2, 3, 4].map((w) => q.capture(w)));
  assert.deepEqual(results, ['img-1', 'img-2', 'img-3', 'img-4']);
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i].t - calls[i - 1].t >= 500, `gap ${i}`);
});

test('quota errors are retried with backoff instead of dropping the step', async () => {
  const clock = fakeClock();
  let n = 0;
  const q = createCaptureQueue({ ...clock, retryDelaysMs: [100, 200, 400], capture: async () => { n += 1; if (n < 3) throw QUOTA; return 'ok'; } });
  assert.equal(await q.capture(1), 'ok');
  assert.equal(n, 3);
});

test('gives up after the last retry and the queue keeps working', async () => {
  const clock = fakeClock();
  let fail = true;
  const q = createCaptureQueue({ ...clock, retryDelaysMs: [10, 20], capture: async () => { if (fail) throw QUOTA; return 'ok'; } });
  await assert.rejects(q.capture(1), /MAX_CAPTURE/);
  fail = false;
  assert.equal(await q.capture(2), 'ok');
});

test('non-quota errors fail at once', async () => {
  const clock = fakeClock();
  let n = 0;
  const q = createCaptureQueue({ ...clock, capture: async () => { n += 1; throw new Error('Cannot access a chrome:// URL'); } });
  await assert.rejects(q.capture(1), /chrome:\/\//);
  assert.equal(n, 1);
  assert.equal(isQuotaError(QUOTA), true);
});

test('step context carries pageTitle and urlPath without query strings', () => {
  const ctx = buildStepContext({ stepNumber: 2, action: 'click', targetLabel: 'Settings', pageTitle: 'Dashboard - LMS', url: 'https://lms.example.edu/course/view?id=42#top' });
  assert.equal(ctx.actionType, 'click');
  assert.equal(ctx.targetLabel, 'Settings');
  assert.equal(ctx.pageTitle, 'Dashboard - LMS');
  assert.equal(ctx.urlPath, 'lms.example.edu/course/view');
  assert.equal(urlPathOf(''), '');
  assert.equal(templateDescription({ actionType: 'navigate', pageTitle: 'Course Catalog' }).instruction, 'Go to Course Catalog.');
});

test('both prompts use the DOCTrace house style and the pinned model', () => {
  for (const p of [SYSTEM_PROMPT, VISION_SYSTEM_PROMPT]) {
    assert.ok(p.includes(STYLE_EXAMPLE));
    assert.ok(p.includes('previousStepSummary'));
    assert.ok(p.includes('pageTitle and urlPath'));
  }
  assert.equal(PROVIDERS.gemini.model, 'gemini-flash-latest');
});

test('a strict-schema timeout or cut-off answer retries in lean JSON mode', async () => {
  const { resetGeminiPreferences } = await import('../../manual_generator/geminiClient.js');
  resetGeminiPreferences();
  const settings = { enabled: true, consent: true, imageConsent: true, apiKey: 'k', endpoint: 'https://x.test/v1beta', model: 'gemini-flash-latest' };
  const strict = [];
  const text = await callGemini(settings, { system: 's', user: 'u' }, [{ stepNumber: 1, base64: 'AQID' }], async (url, init) => {
    const body = JSON.parse(init.body);
    strict.push(Boolean(body.generationConfig.responseSchema));
    if (strict.length === 1) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"steps":[{"stepNu' }] } }] }) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"steps":[]}' }] } }] }) };
  });
  assert.equal(text, '{"steps":[]}');
  assert.deepEqual(strict, [true, false]);
  resetGeminiPreferences();
});

test('a model that stays overloaded (503) switches to gemini-flash-lite-latest', async () => {
  const { resetGeminiPreferences } = await import('../../manual_generator/geminiClient.js');
  resetGeminiPreferences();
  const settings = { enabled: true, consent: true, imageConsent: true, apiKey: 'k', endpoint: 'https://x.test/v1beta', model: 'gemini-flash-latest' };
  const models = [];
  const text = await callGemini(settings, { system: 's', user: 'u' }, [{ stepNumber: 1, base64: 'AQID' }], async (url) => {
    const m = url.match(/models\/([^:]+)/)[1];
    models.push(m);
    if (m === 'gemini-flash-latest') return { ok: false, status: 503, headers: { get: () => null }, text: async () => '{"error":{"status":"UNAVAILABLE"}}' };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ candidates: [{ content: { parts: [{ text: 'lite ok' }] } }] }) };
  });
  assert.equal(text, 'lite ok');
  assert.deepEqual(models, ['gemini-flash-latest', 'gemini-flash-latest', 'gemini-flash-lite-latest']);
  resetGeminiPreferences();
});

test('a 404 model falls back to gemini-flash-latest; a 400 drops the strict schema', async () => {
  const settings = { enabled: true, consent: true, imageConsent: true, apiKey: 'k', endpoint: 'https://x.test/v1beta', model: 'gemini-2.5-flash' };
  const seen = [];
  const ok = { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }) };
  const fail = (status) => ({ ok: false, status, headers: { get: () => null }, text: async () => '{"error":{"status":"X"}}' });
  const text = await callGemini(settings, { system: 's', user: 'u' }, [{ stepNumber: 1, base64: 'AQID' }], async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ model: url.match(/models\/([^:]+)/)[1], thinking: Boolean(body.generationConfig.responseSchema) });
    if (seen.length === 1) return fail(404);
    if (seen.length === 2) return fail(400);
    return ok;
  });
  assert.equal(text, 'done');
  assert.deepEqual(seen, [
    { model: 'gemini-2.5-flash', thinking: true },
    { model: 'gemini-flash-latest', thinking: true },
    { model: 'gemini-flash-latest', thinking: false },
  ]);
});

test('five-part steps are parsed; old title/instruction answers still work', () => {
  const rich = parseManualResponse(JSON.stringify({ steps: [{
    stepNumber: 1, stepTitle: 'View Registered Courses', actionInstruction: "Select 'Registered Courses'.",
    screenContext: 'Shows enrollments.', uiLandmarks: "Under 'Academics' in the left sidebar.", expectedOutcome: 'The course list appears.',
  }] }), [1]).get(1);
  assert.equal(rich.title, 'View Registered Courses');
  assert.equal(rich.instruction, "Select 'Registered Courses'.");
  assert.equal(rich.uiLandmarks, "Under 'Academics' in the left sidebar.");
  assert.equal(rich.expectedOutcome, 'The course list appears.');
  const old = parseManualResponse('{"steps":[{"stepNumber":2,"title":"Open","instruction":"Click Open."}]}', [2]).get(2);
  assert.equal(old.instruction, 'Click Open.');
  assert.equal(old.screenContext, '');
});

test('Gemini request enforces the five-part JSON schema', async () => {
  let body;
  const settings = { enabled: true, consent: true, imageConsent: true, apiKey: 'k', endpoint: 'https://x.test/v1beta', model: 'gemini-2.5-flash' };
  await callGemini(settings, { system: 's', user: 'u' }, [{ stepNumber: 1, base64: 'AQID' }], async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }) };
  });
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseSchema, STEP_RESPONSE_SCHEMA);
  assert.deepEqual(STEP_RESPONSE_SCHEMA.properties.steps.items.required,
    ['stepNumber', 'stepTitle', 'actionInstruction', 'screenContext', 'uiLandmarks', 'expectedOutcome']);
});

test('observe and complete steps get sensible templates', () => {
  assert.equal(templateDescription({ actionType: 'observe', pageTitle: 'Course List' }).instruction, "Review the 'Course List' page.");
  assert.match(templateDescription({ actionType: 'complete', pageTitle: 'Enrollment Confirmed' }).instruction, /task is complete/);
  assert.equal(templateDescription({ actionType: 'observe' }).title, 'Review the page');
});

test('markdown export includes every part of a rich step', () => {
  const md = manualMarkdown({ sessionTitle: 'Enroll', steps: [{
    stepNumber: 1, action: 'click', stepTitle: 'Open Courses', manualTitle: 'Open Courses', stepDescription: "Click 'Courses'.",
    uiLandmarks: 'Left sidebar.', screenContext: 'The dashboard.', expectedOutcome: 'The list opens.', redactedImageFileName: 'step_1.png',
  }] });
  for (const s of ["Click 'Courses'.", '**Where:** Left sidebar.', '**On this screen:** The dashboard.', '**Expected result:** The list opens.']) assert.ok(md.includes(s), s);
});

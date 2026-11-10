// v1.9: time-window matching, parallel OCR/AI, platform adapter. Run: node --test parallel.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { alignNarrationTimeWindow, alignByMode, INTRO_KEY } from '../../voice/narrationAlign.js';
import { createLimiter, ocrWorkerCount } from '../../ocr/ocrPool.js';
import { FrameQueue } from '../../recorder/frameQueue.js';
import { runGeminiGroups, GeminiRequestError } from '../../manual_generator/geminiClient.js';
import { setPlatform, platform, platformName } from '../../platform/platform.js';
import { chromeAdapter } from '../../platform/chromeAdapter.js';
import { rememberPerRequest, SETTINGS_KEY } from '../../manual_generator/settings.js';
import { DWELL_MS } from '../../recorder/liveRecorder.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('observe snapshot fires after 7 seconds', () => {
  assert.equal(DWELL_MS, 7000);
});

test('strict time window: speech between click i and click i+1 belongs to step i (spec Part 1)', () => {
  const T0 = 1_000_000;
  const steps = [1, 2, 3].map((n) => ({ stepNumber: n, timestamp: T0 + n * 10000 }));
  const at = (s, e, text) => ({ startMs: T0 + s, endMs: T0 + e, text });
  const out = alignNarrationTimeWindow([
    at(1000, 3000, 'Hello, welcome.'),          // before step 1 -> intro
    at(11000, 15000, 'Now the first page.'),     // [S1, S2) -> step 1
    at(19000, 22000, 'Crossing click 2.'),       // midpoint 20500 -> step 2
    at(40000, 45000, 'After the last click.'),   // after last -> last step (until end of audio)
  ], steps);
  assert.equal(out.get(INTRO_KEY), 'Hello, welcome.');
  assert.equal(out.get(1), 'Now the first page.');
  assert.equal(out.get(2), 'Crossing click 2.');
  assert.equal(out.get(3), 'After the last click.');
  assert.equal(alignByMode('timeWindow', [at(11000, 12000, 'x')], steps).get(1), 'x');
  assert.ok(alignByMode('smart', [at(11000, 12000, 'x')], steps).size === 1);
});

test('the limiter never runs more than N tasks and keeps FIFO start order', async () => {
  const lim = createLimiter(2);
  let running = 0; let peak = 0; const started = [];
  await Promise.all([1, 2, 3, 4, 5].map((n) => lim.run(async () => {
    started.push(n); running += 1; peak = Math.max(peak, running);
    await sleep(10); running -= 1; return n;
  })));
  assert.equal(peak, 2);
  assert.deepEqual(started, [1, 2, 3, 4, 5]);
  assert.equal(ocrWorkerCount(8), 2);
  assert.equal(ocrWorkerCount(2), 1);
});

test('FrameQueue with 2 workers runs frames in parallel, drains, and survives a bad frame', async () => {
  let running = 0; let peak = 0; const done = []; const errors = [];
  const q = new FrameQueue(async (job) => {
    running += 1; peak = Math.max(peak, running);
    await sleep(15); running -= 1;
    if (job.bad) throw new Error('bad frame');
    done.push(job.n);
  }, { concurrency: 2, onError: (e, job) => errors.push(job.n) });
  for (const n of [1, 2, 3, 4]) q.push({ n, sessionId: 's', bad: n === 2 });
  await sleep(0);
  await q.drain((j) => j.sessionId === 's');
  assert.equal(peak, 2);
  assert.deepEqual(done.sort(), [1, 3, 4]);
  assert.deepEqual(errors, [2]);
  assert.equal(q.size, 0);
});

test('AI groups run 2 at a time; a daily quota error skips groups not started yet', async () => {
  let running = 0; let peak = 0; const seen = [];
  const groups = [[1], [2], [3], [4], [5]];
  const { dailyQuotaExhausted } = await runGeminiGroups(groups, async ([n]) => {
    running += 1; peak = Math.max(peak, running);
    await sleep(10); running -= 1;
    if (n === 2) throw new GeminiRequestError('DAILY_QUOTA', 'quota', { dailyQuotaExhausted: true });
    return { results: new Map([[n, { title: 't', instruction: 'i' }]]) };
  }, async (group, res) => { seen.push([group[0], res.skipped ? 'skipped' : res.error ? 'error' : 'ok']); }, { concurrency: 2 });
  assert.equal(dailyQuotaExhausted, true);
  assert.equal(peak, 2);
  const status = Object.fromEntries(seen);
  assert.equal(status[1], 'ok');
  assert.equal(status[2], 'error');
  assert.equal(status[5], 'skipped');
});

test('platform adapter: incomplete adapters are refused; core code uses the active one', async () => {
  assert.throws(() => setPlatform({ kv: {} }), /missing/);
  const store = {};
  const fake = {
    name: 'test-desktop',
    kv: { available: () => true, get: async (k) => (Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, store[x]])) : { [k]: store[k] }), set: async (o) => Object.assign(store, o), remove: async () => {} },
    capture: { visibleTab: async () => 'data:image/png;base64,' }, files: { save: async () => {}, setQuiet: async () => {} },
    net: { fetch: async () => ({}) }, ui: { openPage: async () => {}, openSettings: async () => {}, badge: async () => {} }, runtime: { url: (p) => p },
  };
  try {
    setPlatform(fake);
    assert.equal(platformName(), 'test-desktop');
    store[SETTINGS_KEY] = { provider: 'groq' };
    await rememberPerRequest('groq', 1); // settings.js now writes through the adapter, not chrome.*
    assert.deepEqual(store[SETTINGS_KEY].learnedPerRequest, { groq: 1 });
    assert.equal(await platform.capture.visibleTab(1), 'data:image/png;base64,');
  } finally {
    setPlatform(chromeAdapter);
  }
  assert.equal(platformName(), 'chrome-extension');
});

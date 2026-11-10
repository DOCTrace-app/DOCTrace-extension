// Node tests for the recording features (no browser needed):
// FIFO queue order + backpressure + drain, text scrubber, URL scrubber,
// LLM privacy guard, response parser, template fallback.
//   node group2/tests/node/recorder.test.mjs
import { readFileSync } from 'node:fs';
import { FrameQueue } from '../../recorder/frameQueue.js';
import { SensitiveClassifier } from '../../detection/mlClassifier.js';
import { scrubTextSync, scrubUrlSync } from '../../privacy/textScrubber.js';
import { guardContexts, buildPrompt, parseManualResponse, templateDescription, PrivacyGuardError, humanizeTokens } from '../../manual_generator/manualGenerator.js';

const clf = new SensitiveClassifier(JSON.parse(readFileSync(new URL('../../model/sensitive_model.json', import.meta.url))));
let failed = 0;
const check = (name, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d ? '  ' + d : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- queue ----
{
  const order = []; let running = 0; let maxRunning = 0;
  const q = new FrameQueue(async (job) => { running++; maxRunning = Math.max(maxRunning, running); await sleep(5); order.push(job.n); running--; }, { maxQueued: 3 });
  const results = [1, 2, 3, 4, 5].map((n) => q.push({ n, sessionId: 's' }));
  check('queue accepts up to its limit', results.filter((r) => r.accepted).length >= 3);
  check('queue refuses with QUEUE_FULL when full', results.some((r) => r.code === 'QUEUE_FULL'));
  await q.drain((j) => j?.sessionId === 's');
  check('queue processes in FIFO order', JSON.stringify(order) === JSON.stringify(order.slice().sort((a, b) => a - b)), order.join(','));
  check('queue never runs two jobs at once', maxRunning === 1);
  const q2 = new FrameQueue(async (job) => { if (job.bad) throw new Error('boom'); order.push('ok'); }, { onError: () => order.push('err') });
  q2.push({ bad: true }); q2.push({ bad: false });
  await q2.drain();
  check('one failing job does not stop the queue', order.slice(-2).join() === 'err,ok');
}

// ---- text scrubber ----
const cases = [ // [text, expected type, the secret value that must disappear]
  ['maryam@example.com', 'email', 'maryam@example.com'], ['Call 0300-1234567 now', 'phone', '1234567'],
  ['CNIC: 35202-1234567-8', 'cnic', '35202'], ['Password: MySecret123', 'password', 'MySecret123'],
  ['API_KEY: ABC123XYZ', 'api_key', 'ABC123XYZ'], ['Token sk_test_4eC39HqLyjWDarjtT1zdp7dc', 'api_key', 'sk_test'],
];
for (const [text, type, secret] of cases) {
  const r = scrubTextSync(text, clf);
  check(`scrub "${text}"`, r.changed && r.types.includes(type) && !r.text.includes(secret), r.text);
}
for (const text of ['Course Enrollment', 'Click Settings to change your preferences.', 'Total Sales: $10000', 'Forgot password?']) {
  const r = scrubTextSync(text, clf);
  check(`keep normal "${text}"`, !r.changed && r.text === text, r.text);
}
check('tokens are left alone', !scrubTextSync('Email: [REDACTED:email]', clf).changed);
const url = scrubUrlSync('https://lms.example.com/users/maryam@example.com/edit?token=abc123&sid=9#x', clf);
check('URL loses query/hash and PII path segment', !url.includes('token') && !url.includes('maryam') && url.startsWith('https://lms.example.com/users/'), url);

// ---- privacy guard ----
const ctx = { stepNumber: 1, actionType: 'click', targetLabel: 'maryam@example.com', textUnderClick: 'Profile', textNearClick: '', clickArea: 'top-left of the screen', clickedHiddenField: false, hiddenDataOnScreen: ['email'], urlPath: '', scrubbedOcrText: 'Email: ali.raza@example.org\nPassword: [REDACTED:password]' };
const p = buildPrompt({ sessionTitle: 'Test', contexts: [ctx] }, clf);
check('prompt never contains raw PII', !/maryam@|ali\.raza@/.test(p.user), p.user.match(/targetLabel[^\n]*/)?.[0]);
let blocked = false;
try { guardContexts([{ scrubbedOcrText: 'data:image/png;base64,' + 'A'.repeat(500) }], clf); } catch (e) { blocked = e instanceof PrivacyGuardError; }
check('guard blocks image data', blocked);

// ---- parser + template ----
const parsed = parseManualResponse('```json\n{"steps":[{"stepNumber":1,"title":"Open profile","instruction":"Step 1: Click \'Profile\' in the top bar."},{"stepNumber":9,"instruction":"x"}]}\n```', [1]);
check('parser reads fenced JSON, strips "Step 1:", ignores unknown steps', parsed.size === 1 && parsed.get(1).instruction.startsWith('Click'), parsed.get(1)?.instruction);
check('template click', templateDescription({ actionType: 'click', targetLabel: 'Course Enrollment', clickArea: 'top-left of the screen' }).instruction === "Click 'Course Enrollment' in the top-left of the screen.");
check('template input on hidden field stays generic', !/REDACTED/.test(templateDescription({ actionType: 'input', targetLabel: '[REDACTED:password]', clickedHiddenField: true }).instruction));

check('tokens become readable words', humanizeTokens("Type '[REDACTED:email]' and click Next.") === 'Type your email address and click Next.', humanizeTokens("Type '[REDACTED:email]' and click Next."));
check('repeated tokens collapse', humanizeTokens('[REDACTED:api_key] [REDACTED:api_key] is shown') === 'your API key is shown', humanizeTokens('[REDACTED:api_key] [REDACTED:api_key] is shown'));

console.log(failed ? `${failed} FAILED` : 'All recorder tests passed');
process.exit(failed ? 1 : 0);

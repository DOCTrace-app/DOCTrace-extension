// Voice narration: matching speech to steps, Whisper parsing, Note output. Run: node --test voice.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { alignNarration, phrasesFromWhisper, CLICK_SLACK_MS } from '../../voice/narrationAlign.js';
import { buildStepContext, parseManualResponse } from '../../manual_generator/manualGenerator.js';
import { SYSTEM_PROMPT, VISION_SYSTEM_PROMPT } from '../../manual_generator/prompts.js';
import { STEP_RESPONSE_SCHEMA } from '../../manual_generator/geminiClient.js';
import { manualMarkdown } from '../../storage/exportZip.js';

const T0 = 1_760_000_000_000;
const steps = [
  { stepNumber: 1, timestamp: T0 + 5000 },   // click Student
  { stepNumber: 2, timestamp: T0 + 15000 },  // click Sign In
  { stepNumber: 3, timestamp: T0 + 30000 },  // final "complete" snapshot
];

test('speech before a click belongs to that click', () => {
  const out = alignNarration([
    { startMs: T0 + 1000, endMs: T0 + 4000, text: 'Now I will click Student.' },
    { startMs: T0 + 8000, endMs: T0 + 13000, text: 'Enter your credentials and sign in.' },
  ], steps);
  assert.equal(out.get(1), 'Now I will click Student.');
  assert.equal(out.get(2), 'Enter your credentials and sign in.');
  assert.equal(out.has(3), false);
});

test('talking while clicking still counts for that click (slack)', () => {
  const mid = steps[0].timestamp + CLICK_SLACK_MS - 200; // phrase centre just after click 1
  const out = alignNarration([{ startMs: mid - 500, endMs: mid + 500, text: 'here' }], steps);
  assert.equal(out.get(1), 'here');
});

test('speech after the last step goes to the last step; several phrases are joined', () => {
  const out = alignNarration([
    { startMs: T0 + 20000, endMs: T0 + 22000, text: 'Click submit.' },
    { startMs: T0 + 23000, endMs: T0 + 26000, text: 'Only zip and PDF files are allowed.' },
    { startMs: T0 + 40000, endMs: T0 + 42000, text: 'And that is it.' },
  ], steps);
  assert.equal(out.get(3), 'Click submit. Only zip and PDF files are allowed. And that is it.');
});

test('Whisper segments become absolute phrases; silence hallucinations are dropped', () => {
  const phrases = phrasesFromWhisper([
    { start: 1.5, end: 3.0, text: ' Now click Student. ', no_speech_prob: 0.01 },
    { start: 4.0, end: 5.0, text: 'Thank you.', no_speech_prob: 0.2 },
    { start: 6.0, end: 7.0, text: 'noise', no_speech_prob: 0.9 },
  ], T0);
  assert.deepEqual(phrases, [{ startMs: T0 + 1500, endMs: T0 + 3000, text: 'Now click Student.' }]);
});

test('narration reaches the prompt context; prompts explain narration and note', () => {
  const ctx = buildStepContext({ stepNumber: 4, action: 'click', narration: 'Upload your assignment here, only zip and pdf.' });
  assert.equal(ctx.narration, 'Upload your assignment here, only zip and pdf.');
  for (const p of [SYSTEM_PROMPT, VISION_SYSTEM_PROMPT]) {
    assert.ok(p.includes('narration'));
    assert.ok(p.includes('- note:'));
  }
  assert.ok(STEP_RESPONSE_SCHEMA.properties.steps.items.properties.note);
});

test('the note part is parsed and exported to Markdown', () => {
  const r = parseManualResponse('{"steps":[{"stepNumber":1,"stepTitle":"Submit Assignment","actionInstruction":"Click \'Submit\'.","note":"Only ZIP and PDF files are accepted."}]}', [1]).get(1);
  assert.equal(r.note, 'Only ZIP and PDF files are accepted.');
  const md = manualMarkdown({ sessionTitle: 'LMS', steps: [{ stepNumber: 1, action: 'click', stepDescription: "Click 'Submit'.", note: r.note }] });
  assert.ok(md.includes('> **Note:** Only ZIP and PDF files are accepted.'));
});

test('Whisper gets on-screen words as vocabulary, never redacted values', async () => {
  const { vocabularyPrompt } = await import('../../voice/voiceTranscriber.js');
  const p = vocabularyPrompt([
    { targetLabel: 'Fee Challans', pageTitle: 'Student Portal - Bahria University' },
    { targetLabel: '[REDACTED:email]', clickedText: 'Go To LMS' },
    { targetLabel: 'Fee Challans' },
  ]);
  assert.ok(p.includes('Fee Challans') && p.includes('Go To LMS') && p.includes('Bahria University'));
  assert.ok(!p.includes('REDACTED'));
  assert.equal(p.split('Fee Challans').length, 2); // no duplicates
});

test('narrated steps are asked to be fuller', () => {
  assert.ok(SYSTEM_PROMPT.includes('When a step HAS narration'));
  assert.ok(VISION_SYSTEM_PROMPT.includes('EVERY requirement'));
});

// Minimal WebM: EBML header, Segment(unknown size) > Cluster(unknown size) > SimpleBlocks of given sizes.
function fakeWebm(sizes) {
  const out = [0x1A, 0x45, 0xDF, 0xA3, 0x80, 0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0x1F, 0x43, 0xB6, 0x75, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xE7, 0x81, 0x00];
  for (const n of sizes) {
    out.push(0xA3, 0x40 | (n >> 8), n & 0xFF); // 2-byte size vint
    out.push(0x81, 0x00, 0x00, 0x80, ...new Array(n - 4).fill(7)); // track 1, timecode 0, flags, payload
  }
  return new Uint8Array(out);
}

test('a dead microphone (fixed packet size, like Recording 7) is detected as silence', async () => {
  const { analyzeOpusWebm } = await import('../../voice/audioCheck.js');
  const dead = analyzeOpusWebm(fakeWebm(new Array(200).fill(168)));
  assert.equal(dead.silent, true);
  assert.equal(dead.blocks, 200);
  const speech = analyzeOpusWebm(fakeWebm(Array.from({ length: 200 }, (_, i) => 40 + ((i * 37) % 260))));
  assert.equal(speech.silent, false);
  assert.equal(analyzeOpusWebm(fakeWebm([168, 168])).silent, null); // too short to tell
});

test('Whisper echoes of the prompt and low-confidence guesses are dropped', async () => {
  const { reliableSegments, isPromptEcho, vocabularyPrompt } = await import('../../voice/voiceTranscriber.js');
  const prompt = vocabularyPrompt([{ targetLabel: 'Fee Challans' }, { pageTitle: 'Student Portal' }]);
  assert.ok(!/on screen/i.test(prompt));
  assert.equal(isPromptEcho('Fee Challans, Student Portal.', prompt), true);
  assert.equal(isPromptEcho('Now I will open the fee challans page to pay my fee.', prompt), false);
  const kept = reliableSegments([
    { text: 'Click on assignments and upload a zip file.', avg_logprob: -0.3, compression_ratio: 1.4 },
    { text: 'On screen is a great tool for the first time.', avg_logprob: -1.4, compression_ratio: 1.2 },
    { text: 'the the the the the the', avg_logprob: -0.5, compression_ratio: 3.1 },
  ], prompt);
  assert.deepEqual(kept.map((s) => s.text), ['Click on assignments and upload a zip file.']);
});

test('Recording 9: each sentence lands on the step it is about, the greeting becomes the intro', async () => {
  const { alignNarration, INTRO_KEY } = await import('../../voice/narrationAlign.js');
  const B = 1_793_981_000_000; // real step timestamps and labels from Recording 9
  const steps = [
    { stepNumber: 1, action: 'input', timestamp: B + 503966, targetLabel: 'Enrollment:', pageTitle: 'Student - Bahria University' },
    { stepNumber: 2, action: 'input', timestamp: B + 513916, targetLabel: 'Password:', pageTitle: 'Student - Bahria University' },
    { stepNumber: 3, action: 'input', timestamp: B + 519477, targetLabel: 'Institute:', pageTitle: 'Student - Bahria University' },
    { stepNumber: 4, action: 'click', timestamp: B + 529031, targetLabel: 'Sign In', pageTitle: 'Student - Bahria University' },
    { stepNumber: 5, action: 'click', timestamp: B + 533277, targetLabel: 'Go To LMS', pageTitle: 'Dashboard - Bahria University' },
    { stepNumber: 6, action: 'complete', timestamp: B + 537764, targetLabel: '', pageTitle: 'LMS | Student' },
  ];
  const at = (s, e, text) => ({ startMs: B + s, endMs: B + e, text });
  const out = alignNarration([
    at(495000, 501000, 'Hello, so today we are going to do the visit of our Bahria University portal.'),
    at(505500, 513000, 'Over here we will fill up the enrollment number. Then we will fill up the password.'),
    at(515300, 519000, 'From this drop down menu we will select the campus we are in.'),
    at(521000, 527000, 'The tip is that the inside of the portal is same for all of these campuses.'),
    at(530500, 532000, 'This is the dashboard.'),
    at(533500, 537000, 'Here we can go to LMS and this is the LMS.'),
  ], steps);
  assert.match(out.get(INTRO_KEY), /^Hello/);
  assert.equal(out.get(1), 'Over here we will fill up the enrollment number.');
  assert.equal(out.get(2), 'Then we will fill up the password.');
  assert.equal(out.get(3), 'From this drop down menu we will select the campus we are in. The tip is that the inside of the portal is same for all of these campuses.');
  assert.equal(out.has(4), false);
  assert.equal(out.get(5), 'This is the dashboard. Here we can go to LMS');
  assert.equal(out.get(6), 'and this is the LMS.');
});

test('the guide intro is requested with a spoken intro, parsed and exported', async () => {
  const { parseIntro } = await import('../../manual_generator/manualGenerator.js');
  const { buildUserPrompt } = await import('../../manual_generator/prompts.js');
  const user = buildUserPrompt({ sessionTitle: 'Recording 9', previousSteps: [], steps: [], spokenIntro: 'Hello, today we visit the portal.' });
  assert.ok(user.includes('Spoken introduction'));
  for (const p of [SYSTEM_PROMPT, VISION_SYSTEM_PROMPT]) {
    assert.ok(p.includes('"intro"'));
    assert.ok(/Never mention the narrator/.test(p));
    assert.ok(/on-screen spelling/.test(p));
  }
  assert.ok(STEP_RESPONSE_SCHEMA.properties.intro);
  const { readFileSync } = await import('node:fs');
  const { SensitiveClassifier } = await import('../../detection/mlClassifier.js');
  const clf = new SensitiveClassifier(JSON.parse(readFileSync(new URL('../../model/sensitive_model.json', import.meta.url))));
  const intro = parseIntro('{"intro":"This guide shows how to sign in to the Bahria University portal and open the LMS.","steps":[]}', clf);
  assert.equal(intro, 'This guide shows how to sign in to the Bahria University portal and open the LMS.');
  assert.equal(parseIntro('{"steps":[]}', clf), '');
  const md = manualMarkdown({ sessionTitle: 'Recording 9', intro, steps: [] });
  assert.ok(md.includes(intro));
});

test('what was said is shown with its own step in the Markdown and HTML guide', async () => {
  const md = manualMarkdown({ sessionTitle: 'Enroll', spokenIntro: 'Today we enroll.', steps: [
    { stepNumber: 3, action: 'input', spokenNarration: 'Here we select the spring semester.', stepTitle: 'Select Academic Term',
      instruction: "Click the 'Semester' dropdown and select 'Spring 2026'.", whereToFindIt: 'Top center.', redactedImageFileName: 'step_3.png' },
  ] });
  const iTitle = md.indexOf('## Step 3: Select Academic Term');
  const iSaid = md.indexOf('> 🎙 *"Here we select the spring semester."*');
  const iInstr = md.indexOf("Click the 'Semester' dropdown");
  assert.ok(iTitle >= 0 && iSaid > iTitle && iInstr > iSaid, 'narration sits between the step title and its instruction');
  assert.ok(md.includes('> 🎙 *"Today we enroll."*'));
  assert.ok(md.includes('**Where:** Top center.'));

  const { guideHtml } = await import('../../../ui/lib/guideExport.js');
  const html = guideHtml({ sessionTitle: 'Enroll', narrationIntro: 'Today we enroll.' }, [
    { stepNumber: 3, action: 'input', status: 'redacted', manualTitle: 'Select Academic Term', manualDescription: 'Click it.', narration: 'Here we select the <spring> semester.' },
  ]);
  assert.ok(html.includes('class="said"'));
  assert.ok(html.includes('Here we select the &lt;spring&gt; semester.')); // escaped
  assert.ok(html.indexOf('class="said"') < html.indexOf('class="desc"'));
});

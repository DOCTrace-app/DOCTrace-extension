// Detection tests that run in plain Node (no browser needed).
// They use REAL Tesseract output saved in ./fixtures (see makeOcrFixtures.mjs)
// plus a few hand-made OCR layouts for edge cases.
//
//   node group2/tests/node/detection.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import { SensitiveClassifier } from '../../detection/mlClassifier.js';
import { detectSensitive, buildOcrText } from '../../detection/detector.js';
import { parseTesseractData } from '../../ocr/parseTesseract.js';

const root = new URL('../../../', import.meta.url);
const model = JSON.parse(readFileSync(new URL('group2/model/sensitive_model.json', root)));
const classifier = new SensitiveClassifier(model);
const cases = JSON.parse(readFileSync(new URL('testdata/cases.json', root)));
const IMAGE = { width: 1600, height: 1000 };

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
}

// ---- 1. Real OCR fixtures from /testdata ----
for (const c of cases) {
  if (c.expectStatus !== 'redacted') continue;
  if (c.dpr !== undefined && c.dpr < 1.5) { console.log(`SKIP  #${c.id} ${c.name}  (needs canvas upscaling: browser test only)`); continue; }
  const fx = new URL(`group2/tests/node/fixtures/${c.file.replace('.png', '.ocr.json')}`, root);
  if (!existsSync(fx)) { check(`#${c.id} ${c.name}`, false, 'fixture missing'); continue; }
  const lines = parseTesseractData(JSON.parse(readFileSync(fx)), 1);
  const { piiRegions, detections } = detectSensitive(lines, IMAGE, classifier);
  const types = new Set(piiRegions.map((r) => r.type));
  const ocrText = buildOcrText(lines, piiRegions, true);
  const problems = [];
  for (const t of c.expectTypes || []) if (!types.has(t)) problems.push(`missing type ${t}`);
  if (c.maxRegions !== undefined && piiRegions.length > c.maxRegions) problems.push(`${piiRegions.length} regions > ${c.maxRegions}`);
  if (c.minRegions !== undefined && piiRegions.length < c.minRegions) problems.push(`${piiRegions.length} regions < ${c.minRegions}`);
  for (const t of c.expectText || []) if (!ocrText.some((w) => w.text.includes(t))) problems.push(`text "${t}" not extracted`);
  check(`#${c.id} ${c.name}`, !problems.length,
    problems.join(', ') || `regions=${piiRegions.length} [${[...types].join(', ')}]`);
  for (const d of detections) console.log(`        ${d.source.padEnd(15)} ${d.rule.padEnd(24)} ${d.type.padEnd(14)} ${d.score}  "${d.text}"`);
}

// ---- 2. Hand-made layouts ----
function mkLine(index, items) {
  let text = '';
  const words = items.map(([t, x, y, w, h]) => {
    if (text) text += ' ';
    const start = text.length;
    text += t;
    return { text: t, conf: 90, box: { x, y, w, h }, lineIndex: index, start, end: text.length };
  });
  return { index, text, box: { x: words[0].box.x, y: words[0].box.y, w: 1, h: 1 }, words };
}

{
  // Password label with NO readable value: the field area must still be masked.
  const lines = [mkLine(0, [['Password', 100, 100, 110, 20]])];
  const { piiRegions } = detectSensitive(lines, IMAGE, classifier);
  check('Password label with unreadable field is masked (fail closed)',
    piiRegions.some((r) => r.type === 'password' && r.box.w >= 200), JSON.stringify(piiRegions.map((r) => r.box)));
}
{
  // Value far to the right on the same row, in a different OCR line (PSM 11).
  const lines = [mkLine(0, [['API_KEY:', 100, 100, 110, 20]]), mkLine(1, [['ABC123XYZ', 400, 102, 120, 20]])];
  const { piiRegions } = detectSensitive(lines, IMAGE, classifier);
  check('Value on the same row in another OCR line is masked',
    piiRegions.some((r) => r.type === 'api_key' && r.box.x <= 400 && r.box.x + r.box.w >= 520));
}
{
  // Non-label uses of keywords must not mask anything.
  const lines = [
    mkLine(0, [['Forgot', 100, 100, 70, 20], ['password?', 175, 100, 110, 20]]),
    mkLine(1, [['Token', 100, 200, 60, 20], ['expired', 165, 200, 80, 20]]),
    mkLine(2, [['Secret', 100, 300, 70, 20], ['Santa', 175, 300, 60, 20], ['party', 240, 300, 60, 20]]),
  ];
  const { piiRegions } = detectSensitive(lines, IMAGE, classifier);
  check('Keyword used in normal text is not treated as a label', piiRegions.length === 0, JSON.stringify(piiRegions));
}
{
  // Unlabelled secret found only by the ML model.
  const lines = [mkLine(0, [['MySecret123', 100, 100, 140, 20]])];
  const { piiRegions } = detectSensitive(lines, IMAGE, classifier);
  check('Unlabelled "MySecret123" found by ML', piiRegions.some((r) => r.source === 'ml'));
}
{
  // Email label with a normal word next to it must not be masked.
  const lines = [mkLine(0, [['Email', 100, 100, 60, 20]]), mkLine(1, [['Settings', 200, 100, 90, 20]])];
  const { piiRegions } = detectSensitive(lines, IMAGE, classifier);
  check('"Email" menu item next to "Settings" is not masked', piiRegions.length === 0, JSON.stringify(piiRegions));
}
{
  // ocrText must not contain the raw secret.
  const lines = [mkLine(0, [['Contact:', 100, 100, 90, 20], ['maryam@example.com', 200, 100, 220, 20]])];
  const { piiRegions } = detectSensitive(lines, IMAGE, classifier);
  const ocrText = buildOcrText(lines, piiRegions, true);
  check('ocrText hides the email text', !ocrText.some((w) => w.text.includes('maryam')), JSON.stringify(ocrText.map((w) => w.text)));
}

console.log(failed ? `\n${failed} test(s) FAILED` : '\nAll detection tests passed');
process.exit(failed ? 1 : 0);

// DEV TOOL (optional). Runs the SAME Tesseract.js version, language model and
// page-segmentation mode as the extension, but in Node, on /testdata images.
// Saves the raw OCR result so the detection tests can run without a browser.
//
//   npm install --no-save tesseract.js@5.1.1
//   node group2/tests/node/makeOcrFixtures.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../../config.js';

const require = createRequire(import.meta.url);
const { createWorker } = require('tesseract.js');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const cases = JSON.parse(readFileSync(root + 'testdata/cases.json'));
const outDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const worker = await createWorker('eng', 1, { langPath: root + 'group2/vendor/tesseract/lang', cacheMethod: 'none', gzip: true });
await worker.setParameters({ tessedit_pageseg_mode: CONFIG.ocr.pageSegMode, preserve_interword_spaces: '1' });
const files = [...new Set(cases.filter((c) => c.expectStatus === 'redacted' && !(c.dpr < 1.5)).map((c) => c.file))];
for (const file of files) {
  const { data } = await worker.recognize(root + 'testdata/' + file);
  const slim = {
    file,
    lines: data.lines.map((l) => ({ words: l.words.map((w) => ({ text: w.text, confidence: w.confidence, bbox: w.bbox })) })),
  };
  writeFileSync(outDir + file.replace('.png', '.ocr.json'), JSON.stringify(slim, null, 1));
  console.log('fixture', file, data.lines.length, 'lines');
}
await worker.terminate();

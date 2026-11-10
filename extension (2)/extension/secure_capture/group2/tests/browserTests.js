// Browser test runner for processFrame(). Open tests/test.html as an extension
// page (or from a local static server) and read the results.
import { processFrame } from '../pipeline.js';
import { isUploadable, getUploadPayload } from '../privacy/guard.js';
import { loadClassifier } from '../detection/mlClassifier.js';
import { CONFIG } from '../config.js';

const TESTDATA = new URL('../../testdata/', import.meta.url);
const list = document.getElementById('results');
let passed = 0; let failed = 0;

function report(name, ok, detail = '') {
  const li = document.createElement('li');
  li.className = ok ? 'pass' : 'fail';
  li.innerHTML = `${ok ? 'PASS' : 'FAIL'} ${name} <small>${detail}</small>`;
  list.appendChild(li);
  if (ok) passed += 1; else failed += 1;
}

async function sha256(blob) {
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function makeFrame(file, id, dpr = 2) {
  const imageBlob = await (await fetch(new URL(file, TESTDATA))).blob();
  let width = 0; let height = 0;
  try { const b = await createImageBitmap(imageBlob); width = b.width; height = b.height; b.close(); } catch (_) { /* corrupt */ }
  return { frameId: `f-${id}`, sessionId: 's-test', tMs: id * 1000, eventId: `e-${id}`, width, height, dpr, imageBlob, status: 'raw' };
}

// Every PII region must be solid black in the redacted image.
async function regionsAreBlack(blob, regions) {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return regions.every(({ box }) => {
    const [r, g, b] = ctx.getImageData(Math.floor(box.x + box.w / 2), Math.floor(box.y + box.h / 2), 1, 1).data;
    return r === 0 && g === 0 && b === 0;
  });
}

async function runCase(c) {
  const frame = await makeFrame(c.file, c.id, c.dpr ?? 2);
  const before = await sha256(frame.imageBlob);
  const snapshot = { ...frame };
  const out = await processFrame(frame);
  const problems = [];

  if (out.status !== c.expectStatus) problems.push(`status ${out.status}${out.error ? ' (' + out.error + ')' : ''}`);
  for (const k of ['frameId', 'sessionId', 'tMs', 'eventId', 'imageBlob']) {
    if (out[k] !== snapshot[k]) problems.push(`${k} changed`);
  }
  if (await sha256(frame.imageBlob) !== before) problems.push('imageBlob bytes changed');
  if (frame.status !== 'raw') problems.push('input frame object was mutated');

  if (c.expectStatus === 'failed') {
    if (typeof out.error !== 'string') problems.push('no error message');
    if (out.redactedBlob) problems.push('failed frame has redactedBlob');
    if (isUploadable(out)) problems.push('failed frame is uploadable');
  } else if (out.status === 'redacted') {
    const types = new Set(out.piiRegions.map((r) => r.type));
    for (const t of c.expectTypes || []) if (!types.has(t)) problems.push(`missing ${t}`);
    if (c.maxRegions !== undefined && out.piiRegions.length > c.maxRegions) problems.push(`${out.piiRegions.length} regions`);
    if (c.minRegions !== undefined && out.piiRegions.length < c.minRegions) problems.push(`only ${out.piiRegions.length} regions`);
    for (const t of c.expectText || []) if (!out.ocrText.some((w) => w.text.includes(t))) problems.push(`text "${t}" missing`);
    if (!(out.redactedBlob instanceof Blob)) problems.push('no redactedBlob');
    if (!out.ocrText.every((w) => typeof w.text === 'string' && w.box && w.box.x >= 0 && w.box.x + w.box.w <= frame.width + 1)) {
      problems.push('ocrText box outside screenshot pixels');
    }
    if (out.piiRegions.length && !(await regionsAreBlack(out.redactedBlob, out.piiRegions))) problems.push('region not masked');
    if (!isUploadable(out)) problems.push('redacted frame not uploadable');
    if ('imageBlob' in getUploadPayload(out)) problems.push('upload payload contains raw imageBlob');
  }
  const detail = problems.join(', ') || (out.status === 'redacted'
    ? `${out.ocrText.length} words, ${out.piiRegions.length} regions [${[...new Set(out.piiRegions.map((r) => r.type))].join(', ')}]`
    : out.error);
  report(`#${c.id} ${c.name}`, problems.length === 0, detail);
}

async function main() {
  const t0 = performance.now();
  const clf = await loadClassifier(CONFIG.ml.modelUrl);
  const parity = clf.checkParity();
  report('ML model: JavaScript scores match Python', parity.ok, `max diff ${parity.maxDiff.toExponential(2)} over ${parity.rows} rows`);

  const cases = await (await fetch(new URL('cases.json', TESTDATA))).json();
  for (const c of cases) {
    try { await runCase(c); } catch (err) { report(`#${c.id} ${c.name}`, false, `threw: ${err.message}`); }
  }

  const bad = await processFrame({ frameId: 'x', status: 'raw' });
  report('Frame without imageBlob fails safely', bad.status === 'failed' && !isUploadable(bad), bad.error);
  const notObj = await processFrame(null);
  report('processFrame(null) does not throw', notObj.status === 'failed', notObj.error);

  // Network check: every resource this page loaded must be local.
  const remote = performance.getEntriesByType('resource')
    .map((e) => e.name)
    .filter((u) => !u.startsWith(location.origin) && !u.startsWith('chrome-extension://') && !u.startsWith('blob:') && !u.startsWith('data:'));
  report('No network request left the browser (page resources)', remote.length === 0, remote.join(' ') || 'all resources local');

  document.getElementById('summary').innerHTML =
    `<span class="${failed ? 'fail' : 'pass'}">${passed} passed, ${failed} failed</span> <small>in ${Math.round(performance.now() - t0)} ms</small>`;
}

main().catch((err) => { document.getElementById('summary').textContent = 'Test runner error: ' + err.message; });

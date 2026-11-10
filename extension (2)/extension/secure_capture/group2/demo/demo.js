// Demo page: runs processFrame() on a test image and draws each stage.
import { processFrame } from '../pipeline.js';

const $ = (id) => document.getElementById(id);
const TESTDATA = new URL('../../testdata/', import.meta.url);
const TYPE_COLORS = { email: '#e74c3c', phone: '#e67e22', cnic: '#f1c40f', password: '#8e44ad',
  api_key: '#2980b9', credit_card: '#16a085', iban: '#27ae60', passport: '#d35400', national_id: '#b7950b',
  bank_account: '#1e8449', date_of_birth: '#7f8c8d', sensitive_text: '#c0392b' };

async function loadSamples() {
  const cases = await (await fetch(new URL('cases.json', TESTDATA))).json();
  const files = [...new Set(cases.map((c) => c.file))];
  $('sample').innerHTML = files.map((f) => `<option value="${f}">${f}</option>`).join('');
  $('sample').value = '07_mixed_settings.png';
}

async function currentBlob() {
  const file = $('file').files[0];
  if (file) return file;
  const res = await fetch(new URL($('sample').value, TESTDATA));
  return res.blob();
}

async function drawBlob(canvas, blob) {
  const bmp = await createImageBitmap(blob);
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx;
}

function strokeBoxes(ctx, items, color, label) {
  ctx.lineWidth = Math.max(2, ctx.canvas.width / 600);
  ctx.font = `${Math.max(12, ctx.canvas.width / 90)}px sans-serif`;
  for (const it of items) {
    const c = typeof color === 'function' ? color(it) : color;
    ctx.strokeStyle = c;
    ctx.strokeRect(it.box.x, it.box.y, it.box.w, it.box.h);
    if (label) {
      ctx.fillStyle = c;
      ctx.fillText(label(it), it.box.x, Math.max(12, it.box.y - 4));
    }
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function run() {
  $('status').textContent = 'Processing...';
  $('run').disabled = true;
  try {
    const imageBlob = await currentBlob();
    let width = 0; let height = 0;
    try { const b = await createImageBitmap(imageBlob); width = b.width; height = b.height; b.close(); } catch (_) { /* corrupt test file */ }
    const frame = {
      frameId: `demo-${Date.now()}`, sessionId: 'demo-session', tMs: Math.round(performance.now()),
      eventId: 'demo-event', width, height, dpr: Number($('dpr').value) || 1, imageBlob, status: 'raw',
    };
    const out = await processFrame(frame, { debug: true });

    const printable = { ...out, imageBlob: `Blob(${imageBlob.size} bytes, unchanged: ${out.imageBlob === imageBlob})` };
    if (out.redactedBlob) printable.redactedBlob = `Blob(${out.redactedBlob.size} bytes)`;
    delete printable.debug;
    $('output').textContent = JSON.stringify(printable, null, 2);

    if (out.status !== 'redacted') {
      $('status').textContent = `status: ${out.status} - ${out.error}`;
      for (const id of ['cOriginal', 'cOcr', 'cRegions', 'cRedacted']) { const c = $(id); c.width = 1; c.height = 1; }
      $('detTable').querySelector('tbody').innerHTML = '';
      return;
    }
    const d = out.debug;
    await drawBlob($('cOriginal'), imageBlob);
    const ocrCtx = await drawBlob($('cOcr'), imageBlob);
    strokeBoxes(ocrCtx, d.rawOcrWords, '#1e8449');
    $('ocrInfo').textContent = `${d.rawOcrWords.length} words, OCR scale ${d.ocrScale}x, ${d.timingsMs.ocr} ms`;
    $('ocrLines').textContent = d.rawOcrLines.map((l) => `${JSON.stringify(l.box)}  ${l.text}`).join('\n');

    $('detTable').querySelector('tbody').innerHTML = d.detections.map((x) =>
      `<tr><td class="src-${x.source}">${x.source}</td><td>${x.rule}</td><td>${x.type}</td><td>${x.score}</td><td>${esc(x.text)}</td></tr>`,
    ).join('') || '<tr><td colspan="5">Nothing sensitive found</td></tr>';

    const regCtx = await drawBlob($('cRegions'), imageBlob);
    strokeBoxes(regCtx, out.piiRegions, (r) => TYPE_COLORS[r.type] || '#c0392b', (r) => r.type);
    $('regionInfo').textContent = `${out.piiRegions.length} region(s)`;

    await drawBlob($('cRedacted'), out.redactedBlob);
    $('status').textContent = `status: ${out.status} in ${d.timingsMs.total} ms`;
  } catch (err) {
    $('status').textContent = `Demo error: ${err.message}`;
  } finally {
    $('run').disabled = false;
  }
}

$('run').addEventListener('click', run);
loadSamples().then(run);

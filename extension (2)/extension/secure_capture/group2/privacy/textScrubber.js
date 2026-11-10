// Scrub plain text (not pixels) with the SAME detector used on screenshots.
//
// Why: the recorder sends metadata such as targetLabel ("maryam@example.com"
// on a profile button) or a URL (?token=abc123). These never pass through
// OCR, so they need their own scrub before they are stored or given to an LLM.
//
// How: each text line becomes a fake OCR line (words placed left to right
// with fake boxes), then detectSensitive() runs regex + keyword/spatial + ML
// on it, exactly as on a screen. Words inside a detected region become
// [REDACTED:type]. Existing tokens are kept as they are.

import { CONFIG } from '../config.js';
import { detectSensitive, REDACTION_TOKEN } from '../detection/detector.js';
import { loadClassifier } from '../detection/mlClassifier.js';
import { centerX, centerY, containsPoint } from '../detection/geometry.js';

const WORD_H = 20;
const CHAR_W = 10;
const SPACE_W = 10;
const LINE_GAP = 60; // far apart, so spatial rules never link two lines by mistake

function toFakeLines(text) {
  const lines = [];
  String(text).split(/\r?\n/).forEach((raw, li) => {
    const parts = raw.split(/\s+/).filter(Boolean);
    let x = 0;
    let lineText = '';
    const words = parts.map((t) => {
      // A token is replaced by a neutral word so the detector does not react to it.
      const isToken = REDACTION_TOKEN.test(t);
      const det = isToken ? 'REDACTED' : t;
      if (lineText) lineText += ' ';
      const start = lineText.length;
      lineText += det;
      const w = { text: det, original: t, isToken, conf: 100, lineIndex: lines.length, start, end: lineText.length,
        box: { x, y: li * LINE_GAP, w: Math.max(CHAR_W, det.length * CHAR_W), h: WORD_H } };
      x += w.box.w + SPACE_W;
      return w;
    });
    if (words.length) {
      lines.push({ index: lines.length, text: lineText, box: { x: 0, y: li * LINE_GAP, w: x, h: WORD_H }, words });
    }
  });
  return lines;
}

/**
 * @returns {{ text: string, types: string[], changed: boolean }}
 */
export function scrubTextSync(text, classifier) {
  if (text === undefined || text === null || text === '') return { text: text ?? '', types: [], changed: false };
  const lines = toFakeLines(text);
  if (!lines.length) return { text: String(text), types: [], changed: false };
  const width = Math.max(...lines.map((l) => l.box.w)) + 1000;
  const height = lines.length * LINE_GAP + 1000;
  const { piiRegions } = detectSensitive(lines, { width, height }, classifier, CONFIG);
  const types = new Set();
  const outLines = lines.map((line) => {
    const out = [];
    for (const w of line.words) {
      if (w.isToken) { out.push(w.original); continue; }
      const region = piiRegions.find((r) => containsPoint(r.box, centerX(w.box), centerY(w.box)));
      if (!region) { out.push(w.original); continue; }
      types.add(region.type);
      const token = `[REDACTED:${region.type}]`;
      if (out.at(-1) !== token) out.push(token);
    }
    return out.join(' ');
  });
  const result = outLines.join('\n');
  return { text: result, types: [...types], changed: types.size > 0 };
}

export async function scrubText(text, classifier = null) {
  const clf = classifier || await loadClassifier(CONFIG.ml.modelUrl);
  return scrubTextSync(text, clf);
}

/**
 * Keep only origin + path of a URL (drop ?query and #hash, which often hold
 * tokens, emails or IDs), then scrub the path too.
 */
export function scrubUrlSync(url, classifier) {
  if (!url) return '';
  let kept;
  try {
    const u = new URL(url);
    kept = `${u.origin}${u.pathname}`;
  } catch {
    kept = String(url).split(/[?#]/)[0];
  }
  // Path segments are scrubbed one by one ("/users/maryam@example.com/edit").
  const segs = kept.split('/').map((seg) => {
    if (!seg || /^https?:$/.test(seg)) return seg;
    const r = scrubTextSync(decodeURIComponentSafe(seg), classifier);
    return r.changed ? r.text : seg;
  });
  return segs.join('/');
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Combine all detection methods into one list of PII regions.
//
//   A. Regex            high-confidence patterns (email, phone, CNIC, keys)
//   B. Keywords         sensitive labels (Password:, API_KEY:, CNIC:)
//   C. Spatial context  value to the right of / below a label
//   D. ML classifier    TF-IDF + Logistic Regression on words and lines
//
// Decision: a word is sensitive if ANY method says so (logical OR).
// Regex and label rules are trusted; ML adds coverage for values that no
// rule describes (e.g. "MySecret123" with no label).

import { CONFIG } from '../config.js';
import { allWords } from '../ocr/parseTesseract.js';
import { centerX, centerY, clamp, containsPoint, coveredBy, pad, roundBox, union } from './geometry.js';
import { findKeywordLabels } from './keywordRules.js';
import { findRegexMatches } from './regexRules.js';
import { findSpatialValues } from './spatialRules.js';

const PURE_NUMBER = /^[\d\s.,:;/+\-()$%#€£]+$/;
const MASK_CHARS = /^[*•●·]{4,}$/;

export function mlEligible(text, mlCfg) {
  if (MASK_CHARS.test(text)) return true;
  if (text.length < mlCfg.minChars) return false;
  if (!/[A-Za-z0-9]/.test(text)) return false;
  if (mlCfg.skipPureNumbers && PURE_NUMBER.test(text)) return false;
  return true;
}

function priority(type, cfg) {
  const i = cfg.typePriority.indexOf(type);
  return i === -1 ? cfg.typePriority.length : i;
}

// Remove duplicates: a box that is (almost) inside a kept box is dropped.
function mergeRegions(regions, cfg) {
  const sorted = [...regions].sort((a, b) =>
    priority(a.type, cfg) - priority(b.type, cfg)
    || b.score - a.score
    || b.box.w * b.box.h - a.box.w * a.box.h);
  const kept = [];
  for (const r of sorted) {
    if (kept.some((k) => coveredBy(r.box, k.box) >= 0.8)) continue;
    const sameTypeInside = kept.find((k) => k.type === r.type && coveredBy(k.box, r.box) >= 0.8);
    if (sameTypeInside) {
      sameTypeInside.box = union([sameTypeInside.box, r.box]);
      continue;
    }
    kept.push({ ...r });
  }
  return kept;
}

/**
 * @param lines       OCR lines from parseTesseractData
 * @param image       { width, height } in screenshot pixels
 * @param classifier  SensitiveClassifier or null
 * @returns { piiRegions, detections, labels }
 */
export function detectSensitive(lines, image, classifier, cfg = CONFIG) {
  const words = allWords(lines);
  const labels = findKeywordLabels(lines, cfg.keywords, cfg.maxKeywordWords);
  const labelWords = new Set(labels.flatMap((l) => l.words));
  const mlScore = classifier ? (t) => classifier.predict(t) : null;
  const hits = [];

  // A. Regex
  for (const h of findRegexMatches(lines)) {
    hits.push({ ...h, source: 'regex', box: union(h.words.map((w) => w.box)) });
  }

  // B + C. Keyword label + spatial value
  for (const h of findSpatialValues(labels, lines, cfg.spatial, mlScore)) {
    hits.push({ ...h, source: 'keyword_spatial' });
  }

  // D. ML classifier
  if (classifier) {
    const covered = new Set(hits.flatMap((h) => h.words));
    for (const w of words) {
      if (covered.has(w) || labelWords.has(w) || !mlEligible(w.text, cfg.ml)) continue;
      const p = classifier.predict(w.text);
      if (p >= cfg.ml.wordThreshold) {
        hits.push({ source: 'ml', rule: 'ml_word', type: 'sensitive_text', words: [w], box: w.box, score: p });
        covered.add(w);
      }
    }
    for (const line of lines) {
      if (line.words.length < 2 || line.words.some((w) => covered.has(w))) continue;
      const p = classifier.predict(line.text);
      if (p < cfg.ml.lineThreshold) continue;
      const inLine = line.words.filter((w) => !labelWords.has(w) && mlEligible(w.text, cfg.ml)
        && classifier.predict(w.text) >= cfg.ml.lineWordThreshold);
      const target = inLine.length ? inLine : line.words; // fail closed: whole line
      hits.push({ source: 'ml', rule: 'ml_line', type: 'sensitive_text', words: target, box: union(target.map((w) => w.box)), score: p });
    }
  }

  // Pad, clamp to the image, merge duplicates
  const rc = cfg.redaction;
  const regions = hits
    .map((h) => {
      const p = Math.max(rc.padMin, rc.padFactor * h.box.h);
      return { ...h, box: roundBox(clamp(pad(h.box, p), image.width, image.height)) };
    })
    .filter((h) => h.box.w > 0 && h.box.h > 0);
  const merged = mergeRegions(regions, cfg);

  return {
    piiRegions: merged.map((r) => ({ type: r.type, box: r.box, source: r.source, score: Math.round(r.score * 1000) / 1000 })),
    detections: hits.map((h) => ({
      source: h.source, rule: h.rule, type: h.type, score: Math.round(h.score * 1000) / 1000,
      text: h.words.map((w) => w.text).join(' '), box: roundBox(h.box),
    })),
    labels: labels.map((l) => ({ type: l.type, text: l.words.map((w) => w.text).join(' '), box: l.box })),
  };
}

/**
 * ocrText for the output frame. Words inside a PII region get their text
 * replaced, so the raw secret is not stored in the database as text.
 */
export function buildOcrText(lines, piiRegions, maskText) {
  return allWords(lines).map((w) => {
    const cx = centerX(w.box);
    const cy = centerY(w.box);
    const region = maskText ? piiRegions.find((r) => containsPoint(r.box, cx, cy)) : null;
    return { text: region ? `[REDACTED:${region.type}]` : w.text, box: { ...w.box } };
  });
}

export const REDACTION_TOKEN = /^\[REDACTED:[a-z_]+\]$/;

/**
 * Plain text of the screen, one OCR line per text line, with every word
 * inside a PII region replaced by [REDACTED:type]. Repeated tokens next to
 * each other are collapsed ("[REDACTED:password] [REDACTED:password]" -> one).
 * This is the only OCR text that may be stored or sent to an LLM.
 */
export function buildScrubbedText(lines, piiRegions) {
  return lines.map((line) => {
    const out = [];
    for (const w of line.words) {
      const cx = centerX(w.box);
      const cy = centerY(w.box);
      const region = piiRegions.find((r) => containsPoint(r.box, cx, cy));
      const text = region ? `[REDACTED:${region.type}]` : w.text;
      if (region && out.at(-1) === text) continue;
      out.push(text);
    }
    return out.join(' ');
  }).filter(Boolean).join('\n');
}

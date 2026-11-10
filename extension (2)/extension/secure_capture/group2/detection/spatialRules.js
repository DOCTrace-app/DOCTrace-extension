// Spatial context: use OCR boxes to find the VALUE that belongs to a label.
//
//   Password: MySecret123        value is on the RIGHT (same row)
//
//   Password                     value is BELOW (form field under its label)
//   [ •••••••••• ]
//
// For secret labels (password, API key, card) the value text is often not
// readable (******** or dots). Then we mask the likely input-field area
// anyway. This is fail-closed: masking a little too much is safer than
// leaking a password.

import { bottom, centerY, pad, right, union } from './geometry.js';

const looksLikeData = (text) => /[0-9@]/.test(text);

function sameRow(labelBox, wordBox, tol) {
  const h = Math.max(labelBox.h, wordBox.h);
  return Math.abs(centerY(labelBox) - centerY(wordBox)) <= tol * h;
}

function isLabelWord(word, labelWordSet) {
  return labelWordSet.has(word);
}

// Words to the right of the label on the same visual row (can be a different
// OCR line, because PSM 11 splits far-apart text into separate lines).
function valueOnRight(label, words, labelWordSet, cfg) {
  const h = label.box.h;
  const candidates = words
    .filter((w) => !label.words.includes(w))
    .filter((w) => w.box.x >= right(label.box) - 2)
    .filter((w) => sameRow(label.box, w.box, cfg.sameRowTolerance))
    .sort((a, b) => a.box.x - b.box.x);
  const picked = [];
  let lastRight = right(label.box);
  for (const w of candidates) {
    const gap = w.box.x - lastRight;
    const limit = picked.length === 0 ? cfg.rightMaxGap * h : cfg.valueWordGap * h;
    if (gap > limit) break;
    if (isLabelWord(w, labelWordSet)) break; // next label starts
    picked.push(w);
    lastRight = right(w.box);
    if (picked.length >= cfg.maxValueWords) break;
  }
  return picked;
}

// Nearest row of words just below the label, roughly aligned with it.
function valueBelow(label, words, labelWordSet, cfg) {
  const h = label.box.h;
  const top = bottom(label.box);
  const minX = label.box.x - cfg.belowIndent * h;
  const maxX = label.box.x + Math.max(label.box.w, cfg.estimatedFieldWidth * h);
  const candidates = words
    .filter((w) => !label.words.includes(w) && !isLabelWord(w, labelWordSet))
    .filter((w) => w.box.y >= top - 0.2 * h && w.box.y - top <= cfg.belowMaxDistance * h)
    .filter((w) => right(w.box) >= minX && w.box.x <= maxX);
  if (!candidates.length) return [];
  const firstY = Math.min(...candidates.map((w) => centerY(w.box)));
  return candidates
    .filter((w) => Math.abs(centerY(w.box) - firstY) <= cfg.sameRowTolerance * h)
    .sort((a, b) => a.box.x - b.box.x)
    .slice(0, cfg.maxValueWords);
}

// Turn value word boxes into a field-sized box (secret labels only).
function fieldBox(valueBox, labelH, cfg) {
  const h = Math.max(labelH, valueBox.h);
  const box = pad(valueBox, cfg.fieldPadX * h, cfg.fieldPadY * h);
  const minW = cfg.fieldMinWidth * h;
  if (box.w < minW) box.w = minW;
  return box;
}

/**
 * @param labels   output of findKeywordLabels
 * @param lines    OCR lines
 * @param cfg      CONFIG.spatial
 * @param mlScore  optional (text) => probability, used for non-secret labels
 * @returns [{ rule, type, box, words, score }]
 */
export function findSpatialValues(labels, lines, cfg, mlScore = null) {
  const words = lines.flatMap((l) => l.words);
  const labelWordSet = new Set(labels.flatMap((l) => l.words));
  const hits = [];

  for (const label of labels) {
    const h = label.box.h;
    let value = valueOnRight(label, words, labelWordSet, cfg);
    let where = 'right';
    if (!value.length) {
      value = valueBelow(label, words, labelWordSet, cfg);
      where = 'below';
    }

    if (!label.secret) {
      // Email / phone / CNIC label: only mask values that look like data.
      value = value.filter((w) => looksLikeData(w.text) || (mlScore && mlScore(w.text) >= 0.5));
      if (value.length) {
        hits.push({ rule: `spatial_${where}`, type: label.type, words: value, box: union(value.map((w) => w.box)), score: 0.9 });
      }
      continue;
    }

    if (value.length) {
      const box = fieldBox(union(value.map((w) => w.box)), h, cfg);
      hits.push({ rule: `spatial_${where}`, type: label.type, words: value, box, score: 0.95 });
      continue;
    }

    // Nothing readable next to a secret label: mask where the field should be.
    const fh = cfg.estimatedFieldHeight * h;
    const fw = cfg.estimatedFieldWidth * h;
    const rightArea = { x: right(label.box) + 0.3 * h, y: centerY(label.box) - fh / 2, w: fw, h: fh };
    const belowArea = { x: label.box.x - 0.3 * h, y: bottom(label.box), w: fw, h: fh };
    const isWholeLine = lines[label.lineIndex]?.words.length === label.words.length;
    hits.push({ rule: 'spatial_estimated_right', type: label.type, words: [], box: rightArea, score: 0.6 });
    if (isWholeLine) {
      hits.push({ rule: 'spatial_estimated_below', type: label.type, words: [], box: belowArea, score: 0.6 });
    }
  }
  return hits; // boxes are clamped to the image later, in detector.js
}

// Find sensitive LABELS such as "Password", "API_KEY:", "Card Number".
// The label itself is not hidden; it tells the spatial rule where to look
// for the value (see spatialRules.js).
//
// A keyword only counts as a LABEL when:
//   (a) it ends with ":" or "="          ->  "Password: ****"
//   (b) or it is the whole OCR line      ->  "Password" written above an input field
// So "Forgot password?", "Enter your password" or "Token expired" are NOT labels.

import { union } from './geometry.js';

export const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function buildLookup(keywords) {
  const map = new Map();
  for (const group of keywords) {
    for (const term of group.terms) map.set(squash(term), group);
  }
  return map;
}

/**
 * @returns [{ type, secret, words: [labelWords], box, lineIndex, lastWordIndex }]
 */
export function findKeywordLabels(lines, keywords, maxWords = 3) {
  const lookup = buildLookup(keywords);
  const labels = [];
  for (const line of lines) {
    const ws = line.words;
    let i = 0;
    while (i < ws.length) {
      let found = null;
      // Try the longest phrase first: "Confirm new password" before "password"
      for (let n = Math.min(maxWords, ws.length - i); n >= 1 && !found; n--) {
        const phrase = ws.slice(i, i + n);
        const group = lookup.get(squash(phrase.map((w) => w.text).join('')));
        if (!group) continue;
        const last = phrase[phrase.length - 1].text;
        const endsWithSeparator = /[:=]$/.test(last);
        const wholeLine = n === ws.length;
        if (endsWithSeparator || wholeLine) {
          found = {
            type: group.type,
            secret: group.secret,
            words: phrase,
            box: union(phrase.map((w) => w.box)),
            lineIndex: line.index,
            lastWordIndex: i + n - 1,
          };
        }
      }
      if (found) {
        labels.push(found);
        i = found.lastWordIndex + 1;
      } else {
        i += 1;
      }
    }
  }
  return labels;
}

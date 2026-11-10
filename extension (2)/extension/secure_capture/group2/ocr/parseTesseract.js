// Convert a Tesseract.js v5 result into our own simple structure.
// Pure function (no browser APIs), so it can be unit tested in Node.
//
// `scale` is the factor the image was enlarged by before OCR.
// Dividing by it brings every box back to ORIGINAL screenshot pixels.
//
// Output:
//   lines: [{ index, text, box, words: [{ text, conf, box, lineIndex, start, end }] }]
// `start`/`end` are character offsets of the word inside line.text, used to
// map regex matches on a line back to word boxes.

function toBox(bbox, scale) {
  return {
    x: Math.round(bbox.x0 / scale),
    y: Math.round(bbox.y0 / scale),
    w: Math.max(1, Math.round((bbox.x1 - bbox.x0) / scale)),
    h: Math.max(1, Math.round((bbox.y1 - bbox.y0) / scale)),
  };
}

export function parseTesseractData(data, scale = 1) {
  const lines = [];
  for (const tLine of data?.lines || []) {
    const words = [];
    let text = '';
    for (const tWord of tLine.words || []) {
      const wText = (tWord.text || '').trim();
      if (!wText) continue; // Tesseract returns empty "words" for borders/lines
      if (text) text += ' ';
      const start = text.length;
      text += wText;
      words.push({
        text: wText,
        conf: Math.round(tWord.confidence ?? 0),
        box: toBox(tWord.bbox, scale),
        lineIndex: lines.length,
        start,
        end: text.length,
      });
    }
    if (!words.length) continue;
    const xs = words.map((w) => w.box);
    const x1 = Math.min(...xs.map((b) => b.x));
    const y1 = Math.min(...xs.map((b) => b.y));
    const x2 = Math.max(...xs.map((b) => b.x + b.w));
    const y2 = Math.max(...xs.map((b) => b.y + b.h));
    lines.push({ index: lines.length, text, box: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, words });
  }
  return lines;
}

export function allWords(lines) {
  return lines.flatMap((l) => l.words);
}

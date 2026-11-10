// Group 2 entry point: Privacy & Text Extraction.
//
//   raw frame -> decode -> OCR -> detect (regex + keyword/spatial + ML) -> redact -> redacted frame
//
// Runs 100% locally (offscreen document + Tesseract Web Worker).
// It never sends the screenshot anywhere and never changes frame.imageBlob.
// On ANY error it returns status "failed" (fail closed): such a frame has
// no redactedBlob and must not be stored as the recording or uploaded.

import { CONFIG } from './config.js';
import { detectSensitive, buildOcrText, buildScrubbedText } from './detection/detector.js';
import { loadClassifier } from './detection/mlClassifier.js';
import { redactBitmap } from './redaction/redactor.js';
import { createLimiter, ocrWorkerCount } from './ocr/ocrPool.js';

// As many frames at once as there are OCR workers (ocrPool.js: 2 on 4+ core
// machines, else 1). Each worker still gets one image at a time; memory stays bounded.
const limiter = createLimiter(ocrWorkerCount());

/**
 * @param {object} frame  { frameId, sessionId, tMs, eventId, width, height, dpr, imageBlob, status: "raw" }
 * @param {object} [options]
 *   debug: true       adds a `debug` field for the demo page ONLY (contains raw OCR text, never store it)
 *   clickPoint: {x,y} click position in IMAGE pixels; the click marker is redrawn after masking
 *   classifier        a preloaded SensitiveClassifier (tests)
 * @returns {Promise<object>} redacted frame or failed frame. Never throws.
 */
export function processFrame(frame, options = {}) {
  return limiter.run(() => processOne(frame, options));
}

function failed(frame, reason) {
  const out = { ...frame, status: 'failed', error: String(reason || 'unknown error') };
  delete out.redactedBlob; // a failed frame must never look uploadable
  delete out.piiRegions;
  delete out.ocrText;
  return out;
}

async function processOne(frame, options) {
  if (!frame || typeof frame !== 'object') {
    return failed({}, 'Invalid frame: expected an object');
  }
  if (frame.status === 'redacted' && frame.redactedBlob instanceof Blob) {
    return frame; // already processed
  }
  if (!(frame.imageBlob instanceof Blob) || frame.imageBlob.size === 0) {
    return failed(frame, 'Invalid frame: imageBlob is missing or empty');
  }

  const t0 = performance.now();
  let bitmap = null;
  try {
    // 1. Decode (real screenshot pixels, not CSS pixels)
    try {
      bitmap = await createImageBitmap(frame.imageBlob);
    } catch (err) {
      return failed(frame, `Could not decode imageBlob: ${err?.message || err}`);
    }
    const image = { width: bitmap.width, height: bitmap.height };

    // 2. ML model (bundled JSON). Fail closed if it is required and missing.
    let classifier = options.classifier || null;
    if (!classifier) {
      try {
        classifier = await loadClassifier(CONFIG.ml.modelUrl);
      } catch (err) {
        if (CONFIG.ml.required) return failed(frame, `ML model not available: ${err.message}`);
      }
    }

    // 3. OCR (loaded on first use so the heavy WASM starts only when needed)
    const { runOcr } = await import('./ocr/tesseractOcr.js');
    const t1 = performance.now();
    const { lines, scale } = await runOcr(frame.imageBlob, bitmap, frame.dpr);
    const t2 = performance.now();

    // 4. Sensitive detection
    const { piiRegions, detections, labels } = detectSensitive(lines, image, classifier);
    const t3 = performance.now();

    // 5. Redaction on a copy
    const redactedBlob = await redactBitmap(bitmap, piiRegions, CONFIG.redaction,
      { clickPoint: options.clickPoint, dpr: frame.dpr });
    const t4 = performance.now();

    const out = {
      ...frame,
      ocrText: buildOcrText(lines, piiRegions, CONFIG.output.maskSensitiveOcrText),
      scrubbedText: buildScrubbedText(lines, piiRegions), // additive field: masked text, one line per OCR line
      piiRegions,
      redactedBlob,
      status: 'redacted',
    };
    delete out.error;

    if (options.debug) {
      out.debug = {
        image,
        declaredSize: { width: frame.width, height: frame.height },
        sizeMatches: frame.width === image.width && frame.height === image.height,
        ocrScale: scale,
        rawOcrWords: lines.flatMap((l) => l.words.map((w) => ({ text: w.text, conf: w.conf, box: w.box }))),
        rawOcrLines: lines.map((l) => ({ text: l.text, box: l.box })),
        labels,
        detections,
        timingsMs: {
          decodeAndModel: Math.round(t1 - t0),
          ocr: Math.round(t2 - t1),
          detection: Math.round(t3 - t2),
          redaction: Math.round(t4 - t3),
          total: Math.round(t4 - t0),
        },
      };
    }
    return out;
  } catch (err) {
    return failed(frame, err?.message || err);
  } finally {
    try { bitmap?.close(); } catch (_) { /* ignore */ }
  }
}

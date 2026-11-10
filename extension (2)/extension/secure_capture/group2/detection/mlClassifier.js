// Browser version of the Python model (TF-IDF char n-grams + Logistic Regression).
// It reads group2/model/sensitive_model.json, exported by ml_training/export_to_js.py.
// No Python, no server: the math below is the same math scikit-learn does.
//
//   text -> normalizeText -> char_wb n-grams -> TF (sublinear) x IDF -> L2 norm
//        -> dot(coef) + intercept -> sigmoid -> probability of "sensitive"

// Must match normalize_text() in ml_training/common.py.
export function digitRunCode(length) {
  if (length <= 4) return '0'.repeat(length);
  if (length <= 6) return '0000M';
  if (length <= 9) return '0000L';
  if (length <= 12) return '0000X';
  return '0000Z';
}

export function normalizeText(text) {
  return String(text)
    .toLowerCase()
    .replace(/[0-9]+/g, (run) => digitRunCode(run.length))
    .replace(/\s+/g, ' ')
    .trim();
}

// Same as scikit-learn TfidfVectorizer(analyzer="char_wb")._char_wb_ngrams.
// Array.from() indexes by Unicode code point, like Python strings.
export function charWbNgrams(text, minN, maxN) {
  const grams = [];
  const doc = text.replace(/\s\s+/g, ' ');
  for (const word of doc.split(/\s+/).filter(Boolean)) {
    const w = Array.from(' ' + word + ' ');
    const len = w.length;
    for (let n = minN; n <= maxN; n++) {
      let offset = 0;
      grams.push(w.slice(offset, offset + n).join(''));
      while (offset + n < len) {
        offset += 1;
        grams.push(w.slice(offset, offset + n).join(''));
      }
      if (offset === 0) break; // short word counted only once
    }
  }
  return grams;
}

export class SensitiveClassifier {
  constructor(model) {
    if (model?.format !== 'scribe-group2-tfidf-logreg') {
      throw new Error('Unknown model format');
    }
    const v = model.vectorizer;
    if (v.analyzer !== 'char_wb') throw new Error(`Unsupported analyzer ${v.analyzer}`);
    this.model = model;
    this.minN = v.ngramRange[0];
    this.maxN = v.ngramRange[1];
    this.sublinear = v.sublinearTf;
    this.idf = Float64Array.from(v.idf);
    this.coef = Float64Array.from(model.classifier.coef);
    this.intercept = model.classifier.intercept;
    this.threshold = model.threshold ?? 0.5;
    this.index = new Map(v.vocabulary.map((term, i) => [term, i]));
    if (this.idf.length !== this.index.size || this.coef.length !== this.index.size) {
      throw new Error('Model arrays have different sizes');
    }
  }

  /** Probability (0..1) that the text is sensitive. */
  predict(text) {
    const norm = normalizeText(text);
    if (!norm) return 0;
    const counts = new Map();
    for (const g of charWbNgrams(norm, this.minN, this.maxN)) {
      const i = this.index.get(g);
      if (i !== undefined) counts.set(i, (counts.get(i) || 0) + 1);
    }
    let sumSq = 0;
    const weights = [];
    for (const [i, c] of counts) {
      const tf = this.sublinear ? 1 + Math.log(c) : c;
      const w = tf * this.idf[i];
      weights.push([i, w]);
      sumSq += w * w;
    }
    const norm2 = Math.sqrt(sumSq) || 1;
    let z = this.intercept;
    for (const [i, w] of weights) z += (w / norm2) * this.coef[i];
    return 1 / (1 + Math.exp(-z));
  }

  /** Compare with the probabilities Python stored at export time. */
  checkParity(tolerance = 1e-4) {
    let maxDiff = 0;
    for (const row of this.model.parity || []) {
      maxDiff = Math.max(maxDiff, Math.abs(this.predict(row.text) - row.prob));
    }
    return { ok: maxDiff <= tolerance, maxDiff, rows: (this.model.parity || []).length };
  }
}

let cached = null;

/** Load the bundled model once (a local extension file, not a network call). */
export function loadClassifier(url) {
  if (!cached) {
    cached = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Model file not found (${r.status})`);
        return r.json();
      })
      .then((json) => new SensitiveClassifier(json))
      .catch((err) => {
        cached = null;
        throw err;
      });
  }
  return cached;
}

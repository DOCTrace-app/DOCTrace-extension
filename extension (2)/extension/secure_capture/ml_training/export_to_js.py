"""
Export the trained scikit-learn pipeline to a JSON file that plain
JavaScript can run (group2/detection/mlClassifier.js).

What we export:
  - the TF-IDF vocabulary (n-gram strings, in column order)
  - the IDF weight of each column
  - the Logistic Regression weights (coef) and bias (intercept)
  - the text-normalization settings
  - "parity" rows: text + probability computed by Python. The JS side
    re-computes them to prove both sides give the same answer.

Usage:
  python export_to_js.py                      # re-export models/sensitive_classifier.joblib
  (train.py calls export_model() automatically)
"""
import datetime as dt
import json
from pathlib import Path

import joblib

from common import normalize_text

HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE.parent / "group2" / "model" / "sensitive_model.json"


def export_model(pipeline, metrics=None, threshold=0.5, parity_texts=(), out_path=DEFAULT_OUT):
    tfidf = pipeline.named_steps["tfidf"]
    clf = pipeline.named_steps["clf"]

    vocab = [None] * len(tfidf.vocabulary_)
    for term, idx in tfidf.vocabulary_.items():
        vocab[idx] = term

    parity = []
    for text in parity_texts:
        p = float(pipeline.predict_proba([normalize_text(text)])[0, 1])
        parity.append({"text": text, "prob": round(p, 6)})

    model = {
        "format": "scribe-group2-tfidf-logreg",
        "version": 1,
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "preprocessing": {"lowercase": True, "digitsToZero": True, "collapseWhitespace": True},
        "vectorizer": {
            "analyzer": tfidf.analyzer,
            "ngramRange": list(tfidf.ngram_range),
            "sublinearTf": bool(tfidf.sublinear_tf),
            "norm": tfidf.norm,
            "vocabulary": vocab,
            "idf": [round(float(v), 6) for v in tfidf.idf_],
        },
        "classifier": {
            "type": "logistic_regression",
            "coef": [round(float(v), 6) for v in clf.coef_[0]],
            "intercept": round(float(clf.intercept_[0]), 6),
            "classes": [int(c) for c in clf.classes_],
        },
        "threshold": threshold,
        "metrics": metrics or {},
        "parity": parity,
    }
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(model, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    return out_path


if __name__ == "__main__":
    pipe = joblib.load(HERE / "models" / "sensitive_classifier.joblib")
    metrics_file = HERE / "reports" / "metrics.json"
    metrics = json.loads(metrics_file.read_text()) if metrics_file.exists() else {}
    from train import SANITY_NORMAL, SANITY_SENSITIVE
    print("exported ->", export_model(pipe, metrics, metrics.get("threshold", 0.5),
                                      SANITY_NORMAL + SANITY_SENSITIVE))

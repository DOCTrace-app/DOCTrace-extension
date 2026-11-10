"""
Train the sensitive-text classifier.

    dataset.csv -> normalize -> train/test split -> TF-IDF -> Logistic Regression
                -> evaluation -> save model -> export JSON for the browser

Usage (from the ml_training folder):
    python generate_synthetic_dataset.py
    python prepare_ui_datasets.py          # optional, adds real UI text as label 0
    python train.py                        # trains, evaluates, saves, exports

Outputs:
    models/sensitive_classifier.joblib     scikit-learn pipeline (Python use)
    reports/metrics.json                   accuracy, precision, recall, F1, confusion matrix
    reports/confusion_matrix.png           if matplotlib is installed
    ../group2/model/sensitive_model.json   browser model (see export_to_js.py)
"""
import argparse
import json
from pathlib import Path

import joblib
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (accuracy_score, classification_report, confusion_matrix,
                             f1_score, precision_score, recall_score)
from sklearn.model_selection import StratifiedKFold, cross_val_score, train_test_split
from sklearn.pipeline import Pipeline

from common import (ANALYZER, LOGREG_C, MAX_FEATURES, MIN_DF, NGRAM_RANGE, SUBLINEAR_TF,
                    normalize_text)
from export_to_js import export_model

HERE = Path(__file__).resolve().parent
SYNTHETIC = HERE / "data" / "synthetic_privacy_dataset.csv"
UI_NEGATIVES = HERE / "data" / "ui_negatives.csv"
MODEL_PATH = HERE / "models" / "sensitive_classifier.joblib"
REPORTS = HERE / "reports"

# Normal text taken from our own test screens. The model should score all
# of these as NOT sensitive. Printed as a quick sanity check.
SANITY_NORMAL = ["Welcome to Dashboard", "Settings", "Total Sales: $10000", "Orders this week: 128",
                 "12/05/2024", "10:30", "Login", "Reports", "Help", "preferences.", "Language:",
                 "English", "Theme:", "Light", "Password", "Forgot password?", "Username"]
SANITY_SENSITIVE = ["maryam@example.com", "03001234567", "35202-1234567-8", "MySecret123",
                    "ABC123XYZ", "API_KEY: ABC123XYZ", "Password: MySecret123",
                    "sk_test_4eC39HqLyjWDarjtT1zdp7dc", "********"]


def load_data(use_ui):
    df = pd.read_csv(SYNTHETIC, keep_default_na=False)
    df["source"] = "synthetic"
    if use_ui and UI_NEGATIVES.exists():
        ui = pd.read_csv(UI_NEGATIVES, keep_default_na=False)
        df = pd.concat([df, ui[["text", "label", "source"]]], ignore_index=True)
    df["text"] = df["text"].astype(str)
    df["label"] = df["label"].astype(int)
    df["norm"] = df["text"].map(normalize_text)
    df = df[df["norm"].str.len() > 0].reset_index(drop=True)
    return df


def build_pipeline():
    return Pipeline([
        ("tfidf", TfidfVectorizer(analyzer=ANALYZER, ngram_range=NGRAM_RANGE, lowercase=False,
                                  sublinear_tf=SUBLINEAR_TF, min_df=MIN_DF,
                                  max_features=MAX_FEATURES, norm="l2")),
        ("clf", LogisticRegression(C=LOGREG_C, class_weight="balanced", max_iter=3000)),
    ])


def save_confusion_png(cm, path):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return False
    fig, ax = plt.subplots(figsize=(4, 4))
    ax.imshow(cm, cmap="Blues")
    for i in range(2):
        for j in range(2):
            ax.text(j, i, str(cm[i][j]), ha="center", va="center", fontsize=14)
    ax.set_xticks([0, 1], ["normal", "sensitive"])
    ax.set_yticks([0, 1], ["normal", "sensitive"])
    ax.set_xlabel("Predicted")
    ax.set_ylabel("Actual")
    ax.set_title("Confusion matrix (test set)")
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-ui", action="store_true", help="ignore data/ui_negatives.csv")
    ap.add_argument("--test-size", type=float, default=0.2)
    ap.add_argument("--threshold", type=float, default=0.5, help="decision threshold stored in the export")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    df = load_data(not args.no_ui)
    print(f"rows={len(df)}  sensitive={int(df.label.sum())}  normal={int((df.label == 0).sum())}")
    print(df.groupby("source").label.value_counts().to_string(), "\n")

    X_train, X_test, y_train, y_test = train_test_split(
        df["norm"], df["label"], test_size=args.test_size, random_state=args.seed, stratify=df["label"])

    model = build_pipeline()
    model.fit(X_train, y_train)
    prob = model.predict_proba(X_test)[:, 1]
    pred = (prob >= args.threshold).astype(int)

    cm = confusion_matrix(y_test, pred, labels=[0, 1])
    metrics = {
        "test_rows": int(len(y_test)),
        "threshold": args.threshold,
        "accuracy": round(accuracy_score(y_test, pred), 4),
        "precision": round(precision_score(y_test, pred, zero_division=0), 4),
        "recall": round(recall_score(y_test, pred, zero_division=0), 4),
        "f1": round(f1_score(y_test, pred, zero_division=0), 4),
        "confusion_matrix": {"labels": ["normal(0)", "sensitive(1)"], "rows_actual_cols_predicted": cm.tolist()},
    }
    cv = cross_val_score(build_pipeline(), df["norm"], df["label"], scoring="f1",
                         cv=StratifiedKFold(5, shuffle=True, random_state=args.seed))
    metrics["cv5_f1_mean"] = round(float(cv.mean()), 4)
    metrics["cv5_f1_std"] = round(float(cv.std()), 4)

    print("=== Test set evaluation ===")
    for k in ("accuracy", "precision", "recall", "f1"):
        print(f"{k:>10}: {metrics[k]}")
    print(f"  5-fold F1: {metrics['cv5_f1_mean']} +/- {metrics['cv5_f1_std']}")
    print("Confusion matrix (rows = actual, cols = predicted) [normal, sensitive]:")
    print(cm)
    print(classification_report(y_test, pred, target_names=["normal", "sensitive"], zero_division=0))

    # Show mistakes: very useful when you tune the dataset
    test_df = pd.DataFrame({"text": df.loc[X_test.index, "text"], "label": y_test, "prob": prob})
    wrong = test_df[(test_df.prob >= args.threshold).astype(int) != test_df.label]
    if len(wrong):
        print("Misclassified test rows:")
        print(wrong.sort_values("prob").to_string(index=False))

    # Final model: refit on ALL rows (metrics above come from the held-out split)
    final = build_pipeline()
    final.fit(df["norm"], df["label"])

    print("\n=== Sanity check (probability of 'sensitive') ===")
    for group, items in (("should be normal", SANITY_NORMAL), ("should be sensitive", SANITY_SENSITIVE)):
        print(group)
        for t in items:
            p = final.predict_proba([normalize_text(t)])[0, 1]
            print(f"   {p:0.3f}  {t}")

    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORTS.mkdir(parents=True, exist_ok=True)
    joblib.dump(final, MODEL_PATH)
    (REPORTS / "metrics.json").write_text(json.dumps(metrics, indent=2))
    if save_confusion_png(cm, REPORTS / "confusion_matrix.png"):
        print("saved reports/confusion_matrix.png")
    print(f"saved {MODEL_PATH}")
    print("saved reports/metrics.json")

    out = export_model(final, metrics, args.threshold, SANITY_NORMAL + SANITY_SENSITIVE)
    print(f"exported browser model -> {out}")


if __name__ == "__main__":
    main()

"""
Extract real UI text from the two public screen datasets and save it as
NON-sensitive (label 0) training examples.

  Google Screen Annotation  https://github.com/google-research-datasets/screen_annotation
  ENRICO                    https://github.com/luileito/enrico

These datasets have NO privacy labels. We only use their visible UI text
(button labels, titles, list items) as realistic "normal" text, so the
classifier learns not to mask ordinary screens. Any string that looks
sensitive (email, phone, long number, key-like token) is DROPPED so it
cannot pollute the normal class.

Output: data/ui_negatives.csv  (text,label)  and prints simple stats.

Usage:
  python prepare_ui_datasets.py                       # downloads Screen Annotation CSVs
  python prepare_ui_datasets.py --enrico-dir PATH     # also read ENRICO view hierarchies
  python prepare_ui_datasets.py --offline             # only use files already in data/raw

ENRICO view hierarchies: download hierarchies.zip from the ENRICO README
(http://userinterfaces.aalto.fi/enrico/resources/hierarchies.zip), unzip it,
and pass the folder with --enrico-dir. Without it we try the small sample
hierarchy files that live in the ENRICO GitHub repo.

This is training-time only. It never touches screenshots from the extension.
"""
import argparse
import csv
import json
import random
import re
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = HERE / "data" / "raw"
OUT = HERE / "data" / "ui_negatives.csv"

SA_BASE = "https://raw.githubusercontent.com/google-research-datasets/screen_annotation/main/"
SA_FILES = ["train.csv", "test.csv"]
ENRICO_SAMPLE_URLS = [
    "https://raw.githubusercontent.com/luileito/enrico/master/samples/10594-hierarchy.json",
]

# Screen Annotation element format:  TYPE <text> x1 x2 y1 y2
SA_ELEMENT = re.compile(r"\b(TEXT|LABEL|BUTTON)\s+([^(),]+?)\s+\d+\s+\d+\s+\d+\s+\d+")

# Anything matching these is removed from the "normal" set.
SENSITIVE_LOOKING = [
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"),              # email
    re.compile(r"\d[\d\s().+-]{6,}\d"),                  # phone / long number
    re.compile(r"\b(?=\w*\d)(?=\w*[A-Za-z])\w{16,}\b"),  # key-like token
    re.compile(r"(?i)\b(password|passwd|api[_ ]?key|secret|token|cnic)\b\s*[:=]"),
]


def looks_sensitive(text):
    return any(p.search(text) for p in SENSITIVE_LOOKING)


def download(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        return True
    try:
        print("downloading", url)
        urllib.request.urlretrieve(url, dest)
        return True
    except Exception as exc:  # network is optional
        print("  could not download:", exc)
        return False


def screen_annotation_texts(offline):
    texts = []
    for name in SA_FILES:
        path = RAW / "screen_annotation" / name
        if not offline:
            download(SA_BASE + name, path)
        if not path.exists():
            continue
        with path.open(encoding="utf-8", newline="") as f:
            for row in csv.DictReader(f):
                for _, text in SA_ELEMENT.findall(row.get("screen_annotation", "")):
                    texts.append(text.strip())
    return texts


def walk_hierarchy(node, out):
    if isinstance(node, dict):
        for key in ("text", "content-desc"):
            val = node.get(key)
            if isinstance(val, str):
                out.append(val)
            elif isinstance(val, list):
                out.extend(v for v in val if isinstance(v, str))
        for child in node.get("children", []) or []:
            walk_hierarchy(child, out)
    elif isinstance(node, list):
        for child in node:
            walk_hierarchy(child, out)


def enrico_texts(enrico_dir, offline):
    files = []
    if enrico_dir:
        files = sorted(Path(enrico_dir).rglob("*.json"))
    else:
        for url in ENRICO_SAMPLE_URLS:
            dest = RAW / "enrico" / url.rsplit("/", 1)[1]
            if not offline:
                download(url, dest)
            if dest.exists():
                files.append(dest)
    texts = []
    for path in files:
        try:
            walk_hierarchy(json.loads(path.read_text(encoding="utf-8")), texts)
        except Exception:
            continue
    return texts


def clean(texts, source):
    kept, dropped = [], 0
    for t in texts:
        t = re.sub(r"\s+", " ", t).strip()
        if not (1 <= len(t) <= 60):
            continue
        if looks_sensitive(t):
            dropped += 1
            continue
        kept.append((t, source))
    return kept, dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--enrico-dir", default=None, help="folder with ENRICO hierarchy JSON files")
    ap.add_argument("--max", type=int, default=3000, help="max UI strings to keep")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    sa, sa_drop = clean(screen_annotation_texts(args.offline), "screen_annotation")
    en, en_drop = clean(enrico_texts(args.enrico_dir, args.offline), "enrico")
    print(f"Screen Annotation: {len(sa)} strings kept, {sa_drop} dropped as sensitive-looking")
    print(f"ENRICO:            {len(en)} strings kept, {en_drop} dropped as sensitive-looking")

    # de-duplicate, then sample so UI text does not swamp the synthetic set
    unique = {}
    for text, src in sa + en:
        unique.setdefault(text.lower(), (text, src))
    items = list(unique.values())
    rng = random.Random(args.seed)
    rng.shuffle(items)
    # keep every ENRICO string (few), fill the rest with Screen Annotation
    items.sort(key=lambda x: x[1] != "enrico")
    items = items[: args.max]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["text", "label", "source"])
        for text, src in items:
            w.writerow([text, 0, src])
    print(f"wrote {OUT} rows={len(items)}")


if __name__ == "__main__":
    main()

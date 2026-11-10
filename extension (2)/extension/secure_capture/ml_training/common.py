"""
Shared helpers for the ML training code.

IMPORTANT: normalize_text() must behave exactly like normalizeText() in
group2/detection/mlClassifier.js. If you change one, change the other,
then retrain and re-export the model. The export step stores parity test
vectors so the JavaScript side can check it gets the same scores.
"""
import re

DIGIT_RUN = re.compile(r"[0-9]+")
SPACES = re.compile(r"\s+")

# Settings for the TF-IDF vectorizer. They are also written into the
# exported JSON so the browser uses the same values.
ANALYZER = "char_wb"
NGRAM_RANGE = (1, 5)
MAX_FEATURES = 6000
MIN_DF = 2
SUBLINEAR_TF = True


def digit_run_code(length):
    """Short code for a run of digits.

    Runs of 1-4 digits become that many zeros ("128" -> "000").
    Longer runs become "0000" plus an UPPER-CASE length marker. The text is
    already lower-case, so the marker can never clash with real letters:
        5-6 digits  -> 0000M   (counts, prices, postal codes)
        7-9 digits  -> 0000L   (CNIC middle part, local numbers)
        10-12       -> 0000X   (mobile phone numbers)
        13+         -> 0000Z   (CNIC without dashes, card numbers)
    Without this, 5-character n-grams cannot tell 123456 from 03001234567.
    """
    if length <= 4:
        return "0" * length
    if length <= 6:
        return "0000M"
    if length <= 9:
        return "0000L"
    if length <= 12:
        return "0000X"
    return "0000Z"


def normalize_text(text):
    """Lower-case, encode digit runs by length, collapse whitespace.

    Encoding digits lets the model learn the SHAPE of a value
    (for example 0000M-0000L-0 for a CNIC) instead of memorising
    exact fake numbers.
    """
    s = str(text).lower()
    s = DIGIT_RUN.sub(lambda m: digit_run_code(len(m.group())), s)
    s = SPACES.sub(" ", s).strip()
    return s
LOGREG_C = 30.0  # chosen by 5-fold CV comparison of C in {4, 10, 30}

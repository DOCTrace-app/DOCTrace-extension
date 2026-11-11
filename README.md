# DOCTrace

DOCTrace is a Chrome extension that turns your clicks into step-by-step guides. Click through a process once and every click becomes a step, with a screenshot and a written instruction. Emails, phone numbers, ID numbers, card numbers, passwords and API keys are blacked out on your own device before anything is saved.


## Features

- **Record a workflow.** Start a recording from the popup and click through your task. Each click is saved as a guide step.
- **On-device redaction.** Text in each screenshot is read with OCR (Tesseract.js) and checked for sensitive data, which is covered with solid black boxes. OCR and redaction run in your browser. Raw screenshots are never saved or uploaded.
- **One-off protected screenshot.** Capture the current tab with sensitive data hidden, from the popup or with <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>S</kbd>.
- **Step descriptions.** A built-in template writes each step. You can also turn on an AI writer (off by default) with Groq, Mistral, Google Gemini, Anthropic Claude, or any OpenAI-compatible endpoint, including local ones like Ollama and LM Studio.
- **Voice narration (optional).** Talk while you click. Your speech is transcribed with Whisper on Groq and matched to the step you were on.
- **Export.** Save a guide as a PDF, a single HTML page, or a ZIP package (Markdown manual, manifest and screenshots), or copy it as Markdown. Files are also saved to `Downloads/DOCTrace`.

## What gets detected

DOCTrace combines four methods, and a piece of text is hidden if any of them flags it:

| Method | Finds |
|---|---|
| Regex rules | Emails, phone numbers, CNIC, card numbers (Luhn check), IBAN, SSN, NINO, Aadhaar, PAN, passport numbers, JWTs, private keys, and API keys from AWS, Stripe, GitHub, GitLab, Google, OpenAI, Anthropic, Slack and more |
| Keyword labels | Values next to labels such as `Password:`, `API_KEY:`, `CNIC:` and `Card Number` |
| Spatial rules | The value to the right of or below a label, including password fields OCR can't read |
| ML classifier | Secret-looking values that no rule describes. It's a TF-IDF and logistic regression model trained in Python and run in plain JavaScript |

OCR can miss text it can't read, such as text inside photos, so check your guides before sharing them.

## Privacy

- OCR, detection and redaction all run locally. All OCR files are bundled with the extension, so nothing is downloaded from a CDN.
- The AI writer and voice narration are both **off by default** and need your consent before anything is sent.
- Text-only providers (Anthropic, OpenAI-compatible) receive scrubbed step text only, never screenshots.
- Vision providers (Groq, Mistral, Gemini) receive redacted screenshots only after you give separate image consent. Raw screenshots are never sent.
- Voice audio is not scrubbed. It's sent to Groq for transcription and kept with the guide, so don't say passwords out loud.

## Install

DOCTrace isn't on the Chrome Web Store yet, so you load it as an unpacked extension. You need Chrome 116 or newer.

1. Download this repo (**Code > Download ZIP**) and unzip it, or clone it:
   ```bash
   git clone https://github.com/Umer1837/DOCTrace-extension.git
   ```
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder `extension (2)/extension/secure_capture`, the one that contains `manifest.json`.
5. Pin DOCTrace to the toolbar and click its icon to start.

There's no build step. Everything is plain JavaScript ES modules. After changing the code, click the reload icon on the extension card.

## How to use it

1. Click the DOCTrace icon and press **Start recording**. Tick **Record my voice** first if you want narration.
2. Click through the process you want to document.
3. Press **Stop & build guide**, then **Open guide**.
4. On the Guides page, press **Generate manual** to write the steps, then **Export**.

To use an AI writer, open the popup's settings button (or the extension's Options page), choose a provider, paste your API key and give consent.

## Project structure

```
extension (2)/extension/secure_capture/   <- the extension (load this folder in Chrome)
├── manifest.json        Manifest V3 config
├── background.js        service worker: recording, capture, exports
├── content/recorder.js  records clicks on web pages
├── ui/                  popup, Guides page, viewer and Options page
├── group2/              privacy pipeline: OCR, detection, redaction, AI writer, voice
│   ├── pipeline.js      processFrame(): screenshot in, redacted screenshot out
│   ├── config.js        all detection rules and thresholds
│   ├── detection/       regex, keyword, spatial and ML detectors
│   ├── vendor/          bundled Tesseract.js and JSZip
│   ├── demo/            visual demo of each pipeline stage
│   └── tests/           browser and Node tests
├── ml_training/         Python scripts that train and export the ML model
└── testdata/            fake test screenshots and expected results
```

For a detailed tour of the privacy pipeline, its function contract and its design choices, see the [privacy pipeline README](extension%20(2)/extension/secure_capture/group2/README.md).

## Running the tests

You need Node 21 or newer. Run this from the `extension (2)/extension/secure_capture` folder:

```bash
node --test "group2/tests/node/*.test.mjs"
```

In VS Code, you can also run the **Final Group 2 test suite** task from this repo's root.

To run the full browser tests and the visual demo without loading the extension, start the local test server from the same folder:

```bash
node group2/tests/node/serveWithCsp.mjs
```

Then open `http://localhost:8765/group2/tests/test.html` or `http://localhost:8765/group2/demo/demo.html`.

## Retraining the ML model

You need Python 3.9 or newer. From `extension (2)/extension/secure_capture/ml_training`:

```bash
pip install -r requirements.txt
python generate_synthetic_dataset.py
python prepare_ui_datasets.py
python train.py
```

`train.py` exports the model to `group2/model/sensitive_model.json`. Run `node group2/tests/node/mlParity.test.mjs` afterwards to check that the JavaScript scores match Python's.

## About the fake keys in this repo

The test fixtures and training data are full of fake emails, phone numbers and API keys on purpose, because the detector needs them to learn and to be tested. None of them are real. [`.github/secret_scanning.yml`](.github/secret_scanning.yml) tells GitHub's secret scanner to skip those folders, so keep real secrets out of them.

## Third-party licenses

Tesseract.js and tesseract.js-core are Apache-2.0, and JSZip's license is included in `group2/vendor/`. The ML training data uses UI text from Google Screen Annotation (CC BY 4.0) and ENRICO.

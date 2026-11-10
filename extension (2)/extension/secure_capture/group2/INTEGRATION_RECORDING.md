# Recording integration guide (for the partner recorder group)

Send us one frame per user interaction. We redact it on the device, store only the redacted copy in `scribeDB`, and turn the session into a step-by-step manual.

## 1. Two ways to call us

| Your recorder runs in | Use | Why |
|---|---|---|
| The **service worker** (where `chrome.tabs.captureVisibleTab` works) | Direct functions from `group2/integration/recordingApi.js` | Chrome does not deliver `chrome.runtime.sendMessage` to the sender's own context, so a message from the service worker would never reach our service worker listener |
| A **content script, popup or extension page** | `chrome.runtime.sendMessage` with the messages below | Our `background.js` routes them |

Both paths do exactly the same thing and return the same replies.

```js
// Service worker
import { startRecording, pushFrameWithRetry, endRecording } from './group2/integration/recordingApi.js';

const { sessionId } = await startRecording({ sessionTitle: 'Enroll in a course' });
const res = await pushFrameWithRetry({
  sessionId, stepNumber: 1, timestamp: Date.now(), actionType: 'click',
  clickCoords: { x: 420, y: 180 }, coordSpace: 'css', dpr: 2,
  targetLabel: 'Course Enrollment', imageBlob,          // or imageDataUrl
});
const summary = await endRecording(sessionId);          // waits until every frame is processed
```

## 2. Messages

All messages go to `chrome.runtime.sendMessage`. Every reply is `{ ok: true, ... }` or `{ ok: false, code, error }`. Nothing throws.

### Start a session: `SC_REC_START`

```json
{ "type": "SC_REC_START",
  "session": { "sessionId": "optional-your-id", "sessionTitle": "Enroll in a course", "startTime": 1727870000000 } }
```
Reply: `{ "ok": true, "sessionId": "...", "resumed": false }`. Without a `sessionId` we create one. Sending the same id again while recording resumes it.

### Send a frame: `SC_REC_FRAME`

```json
{ "type": "SC_REC_FRAME",
  "frame": {
    "sessionId": "...",
    "stepNumber": 3,
    "frameId": "optional",
    "timestamp": 1727870004200,
    "actionType": "click",
    "clickCoords": { "x": 420, "y": 180 },
    "coordSpace": "css",
    "dpr": 2,
    "viewportWidth": 1280,
    "targetLabel": "Course Enrollment",
    "url": "https://lms.example.com/courses",
    "imageDataUrl": "data:image/png;base64,..."
  } }
```

| Field | Required | Notes |
|---|---|---|
| `sessionId` | yes | From `SC_REC_START` |
| `stepNumber` | recommended | Integer from 1. Missing = next number. A repeated number is refused (`DUPLICATE_STEP`) |
| `timestamp` | recommended | ms since epoch |
| `actionType` | yes | `"click"`, `"input"` or `"navigate"` |
| `clickCoords` | for click/input | `{x, y}` |
| `coordSpace` | no | `"css"` (default, e.g. `MouseEvent.clientX`) or `"image"` (screenshot pixels) |
| `dpr` | strongly recommended with css | `window.devicePixelRatio`. Or send `viewportWidth` and we work it out. Wrong dpr = marker in the wrong place |
| `targetLabel` | no | Visible label of the element. **We scrub it**, so an email shown on a button is never stored |
| `url` | no | We keep only origin + path. Query and `#hash` are dropped, and the path is scrubbed |
| `imageDataUrl` | one of the two | What `captureVisibleTab` returns. From the service worker you may pass `imageBlob` instead |
| `inputValue` | **do not send** | Typed text is never stored. If sent, it is dropped and only a flag is kept |

**Messages carry only JSON**, so a `Blob` cannot be sent with `sendMessage`. Use `imageDataUrl`, or `image: { "__blob": true, "type": "image/png", "base64": "..." }`.

**Your click highlight:** draw it on the screenshot as you do now. We only paint black over sensitive areas. After masking, we draw the click marker again at `clickCoords` so it stays visible. If the click is inside a masked area (for example a password field), we do not redraw it there.

Reply (immediate, before OCR runs): `{ "ok": true, "accepted": true, "sessionId": "...", "stepNumber": 3, "queued": 2 }`

### End the session: `SC_REC_END`

```json
{ "type": "SC_REC_END", "sessionId": "...", "endTime": 1727870090000 }
```
This replies only after every queued frame of the session is processed and stored:
`{ "ok": true, "totalSteps": 12, "failedSteps": [7], "missingSteps": [] }`. Then the manual is written (by the LLM or a template, depending on the settings).

### Status: `SC_REC_STATUS`

```json
{ "type": "SC_REC_STATUS", "sessionId": "..." }
```
Reply: the session record (`status`, `totalSteps`, `failedSteps`, ...) plus `queuedFrames`.

## 3. Error codes

| code | Meaning | What to do |
|---|---|---|
| `QUEUE_FULL` | More than 15 frames are waiting for OCR | Wait `retryAfterMs` (1500 ms) and send again. `pushFrameWithRetry` does this for you |
| `UNKNOWN_SESSION` | No such session | Call start first |
| `SESSION_ENDED` | Session already ended | Start a new session |
| `DUPLICATE_STEP` | That `stepNumber` was already received | Use the next number |
| `INVALID_FRAME` | Missing image or bad `actionType` | Fix the payload |

A frame that cannot be processed (for example a broken image, or OCR failing) is **not** an error reply. It is stored as a `failed` step with **no image** (fail-closed) and listed in `failedSteps`.

## 4. Events we broadcast

You can listen with `chrome.runtime.onMessage`:

- `SC_SESSION_STARTED { sessionId }`
- `SC_STEP_DONE { sessionId, stepNumber, status: "redacted" | "failed", piiTypes }`
- `SC_SESSION_DONE { sessionId, totalSteps, failedSteps, missingSteps }`
- `SC_MANUAL_UPDATED {}`

## 5. Storage (Group 1 / db.js owners, please read)

We add two object stores to **`scribeDB`**: `sc_sessions` (key `sessionId`) and `sc_steps` (key `[sessionId, stepNumber]`). No other database is created.

Adding stores needs a version upgrade. We open `scribeDB` at its **current** version, and only if our stores are missing we upgrade by +1. Our connections close themselves on `versionchange`, so we never block your upgrades.

**Please do not open `scribeDB` with a fixed old version number** (it would fail with `VersionError` after our upgrade). Either open without a version, or create our two stores in your own `onupgradeneeded`.

## 6. Privacy rules we follow

- Raw screenshots stay in the offscreen document's memory until processed, then are released. They are never stored, sent back, or uploaded.
- The offscreen document (which sees raw pixels) makes no network calls.
- Anthropic and OpenAI-compatible providers read only scrubbed records (`withImages: false`) and never receive screenshots. Before each request, a privacy guard scrubs every value again, checks a third pass is clean, and blocks the request if not.
- Gemini is an opt-in exception: only after both text consent and separate image consent, the service worker loads the current group's stored `redactedBlob` images, calls `assertUploadable()` before reading their bytes, and sends JPEG copies plus guarded step text to Google's `generateContent` API. Raw `imageBlob` values are never sent. OCR redaction can miss photos and unreadable text.
- On Google's free tier, Google may use submitted content to improve its products, human reviewers may read it, and Google says not to submit sensitive or personal information. Review Google's current terms before enabling image consent.
- The LLM is off by default. It needs the relevant consent on the Options page. The extension's existing host permission covers the selected endpoint; no new manifest permission is required.

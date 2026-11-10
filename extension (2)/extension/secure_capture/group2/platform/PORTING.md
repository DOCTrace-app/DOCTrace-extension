# Porting DOCTrace to a desktop app (Tauri / Electron)

DOCTrace's core is plain JavaScript (ES modules, Web APIs). Everything it needs
from its host goes through **one adapter** (`platform.js`). A desktop build
provides its own adapter and calls `setPlatform(adapter)` once at start-up.

## 1. What ports as-is (no Chrome APIs)

| Area | Files |
|---|---|
| OCR + PII detection + redaction | `pipeline.js`, `ocr/*`, `detection/*`, `redaction/*`, `privacy/*` |
| Step storage (IndexedDB works in both webviews) | `storage/sessionStore.js` |
| Voice: silence check, Whisper call, step matching | `voice/audioCheck.js`, `voice/voiceTranscriber.js`, `voice/narrationAlign.js` |
| Mic recording (getUserMedia + MediaRecorder) | `voice/voiceRecorder.js` |
| AI step writing (Groq / Mistral / Gemini / Ollama) | `manual_generator/*` |
| Exports (HTML/PDF, Markdown, ZIP) | `storage/exportZip.js`, `ui/lib/guideExport.js` |
| Capture rate limiting | `recorder/captureQueue.js` (inject a different `capture` function) |

## 2. The adapter contract (`platform.js`)

| Method | Chrome extension (`chromeAdapter.js`) | Tauri | Electron |
|---|---|---|---|
| `kv.get/set/remove` | `chrome.storage.local` | `@tauri-apps/plugin-store` | `electron-store` (main) via IPC |
| `capture.visibleTab(id, opts)` | `chrome.tabs.captureVisibleTab` | Rust `xcap` crate (screen/window) -> PNG data URL | `desktopCapturer` + `getUserMedia` frame, or `webContents.capturePage()` |
| `files.save(path, dataUrl)` | `chrome.downloads` (Downloads only) | `@tauri-apps/plugin-fs` `writeFile` into `appDataDir()/DOCTrace` | `fs.promises.writeFile` in main |
| `files.setQuiet(bool)` | hide download bubble | no-op | no-op |
| `net.fetch(url, init, {timeoutMs})` | `llmFetch` (offscreen proxy for >30 s calls) | `@tauri-apps/plugin-http` `fetch` (no CORS) | `net.fetch` in main, or renderer `fetch` |
| `ui.openPage(path)` / `ui.openSettings()` | new tab | new `WebviewWindow` | new `BrowserWindow` |
| `ui.badge(text, color)` | toolbar badge | tray tooltip / no-op | `app.setBadgeCount` / tray |
| `runtime.url(path)` | `chrome.runtime.getURL` | `convertFileSrc` / bundled asset path | `file://` or custom protocol |

A desktop adapter looks like:

```js
import { setPlatform } from './group2/platform/platform.js';
setPlatform({
  name: 'tauri',
  kv: { available: () => true, get, set, remove },
  capture: { visibleTab: async () => invoke('capture_active_window') }, // returns a PNG data URL
  files: { save: (p, dataUrl) => writeDataUrl(`DOCTrace/${p}`, dataUrl), setQuiet: async () => {} },
  net: { fetch: (url, init) => tauriFetch(url, init) },
  ui: { openPage, openSettings, badge: async () => {} },
  runtime: { url: (p) => p },
});
```

## 3. Chrome-only parts a desktop build replaces

| Chrome part | Why it exists | Desktop replacement |
|---|---|---|
| `content/recorder.js` (click + dwell detection inside web pages) | an extension only sees clicks in tabs | global input hooks: `rdev` (Tauri/Rust) or `uiohook-napi` (Electron); label via OS accessibility APIs (UI Automation on Windows) or OCR text under the click |
| `background.js` service worker + 30 s fetch limit | MV3 lifecycle | not needed: the app process stays alive |
| Offscreen document (`offscreen/*`, `bridge/offscreenClient.js`) | service workers cannot run OCR, canvas or the mic | not needed: run these modules directly in the app window |
| `ui/mic.html` permission page | offscreen pages cannot show the mic prompt | OS mic permission (macOS entitlement / Windows privacy), then `getUserMedia` |
| `chrome.tabs.query` / `scripting.executeScript` in `liveRecorder.js` | finding the active tab, injecting the click recorder | active-window info from the OS (`active-win`, `xcap`) |

## 4. Suggested order

1. Create the app shell (Tauri or Electron) that loads `ui/sessions.html`.
2. Write the adapter (section 2) and call `setPlatform` before any DOCTrace module runs.
3. Replace click detection (section 3, row 1) and feed events into `recorder/recorderService.js` (`enqueueFrame`).
4. Offline mode: point `net.fetch` / providers at local models (Ollama vision, whisper.cpp server); the clients already speak the OpenAI-style API.

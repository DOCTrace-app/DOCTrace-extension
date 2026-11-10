// Platform boundary. Everything DOCTrace's core needs from its host goes
// through this one object, so the same core runs as a Chrome extension today
// and as a desktop app (Tauri / Electron) later by swapping the adapter.
//
//   import { platform } from '../platform/platform.js';
//   await platform.kv.get('key');
//
// The adapter contract (every method is async unless noted):
//   kv.get(keys) -> object          kv.set(object)          kv.remove(keys)
//   capture.visibleTab(windowId, { format }) -> data URL of what the user sees
//   files.save(relativePath, dataUrl)          (relative to the app's output folder)
//   files.setQuiet(bool)                        hide download UI while recording (may no-op)
//   net.fetch(url, init) -> Response-like       (long-running LLM / Whisper calls)
//   ui.openPage(path)                           open one of DOCTrace's own pages
//   ui.openSettings()
//   ui.badge(text, color)                       (may no-op)
//   runtime.url(path) -> string  (sync)         URL of a bundled file (model, vendor)
//
// Not part of the contract (host-specific by nature, see PORTING.md):
//   detecting clicks in other apps, the offscreen document, mic permission prompts.

import { chromeAdapter } from './chromeAdapter.js';

let current = chromeAdapter;

export const platform = new Proxy({}, { get: (_, key) => current[key] });

/** Desktop builds call this once at start-up with their own adapter. */
export function setPlatform(adapter) {
  const missing = ['kv', 'capture', 'files', 'net', 'ui', 'runtime'].filter((k) => !adapter?.[k]);
  if (missing.length) throw new Error(`Platform adapter is missing: ${missing.join(', ')}`);
  current = adapter;
}

export const platformName = () => current.name || 'unknown';

// The Chrome extension implementation of the platform contract (platform.js).
// `chrome` is only touched inside the methods, so importing this file in Node
// tests or a desktop build is harmless.

import { llmFetch } from '../bridge/llmFetch.js';

const has = (path) => {
  let o = globalThis.chrome;
  for (const k of path) { o = o?.[k]; if (!o) return false; }
  return true;
};

export const chromeAdapter = {
  name: 'chrome-extension',

  kv: {
    available: () => has(['storage', 'local']),
    get: (keys) => chrome.storage.local.get(keys),
    set: (obj) => chrome.storage.local.set(obj),
    remove: (keys) => chrome.storage.local.remove(keys),
  },

  capture: {
    visibleTab: (windowId, options = { format: 'png' }) => chrome.tabs.captureVisibleTab(windowId, options),
  },

  files: {
    // Chrome only lets an extension save automatically inside Downloads.
    save: (relativePath, dataUrl) => chrome.downloads.download({ url: dataUrl, filename: relativePath, conflictAction: 'overwrite', saveAs: false }),
    setQuiet: async (quiet) => { try { await chrome.downloads.setUiOptions({ enabled: !quiet }); } catch { /* older Chrome */ } },
  },

  net: {
    fetch: (url, init, opts) => llmFetch(url, init, opts),
  },

  ui: {
    openPage: (path) => chrome.tabs.create({ url: chrome.runtime.getURL(path) }),
    openSettings: () => chrome.runtime.openOptionsPage(),
    badge: async (text, color) => {
      try {
        if (color) await chrome.action.setBadgeBackgroundColor({ color });
        await chrome.action.setBadgeText({ text });
      } catch { /* ignore */ }
    },
  },

  runtime: {
    url: (path) => (has(['runtime', 'getURL']) ? chrome.runtime.getURL(path) : path),
  },
};

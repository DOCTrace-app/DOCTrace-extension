// Content script: runs on web pages. While a recording is active it reports
// each click (position + a short label of what was clicked) to the service
// worker, which then takes the screenshot.
//
// Dwell trigger: when the user stays on a screen without clicking, typing or
// scrolling for dwellMs (default 7 s), it asks for one "observe" snapshot so
// passive views (dashboards, course lists, tables) are not missed. Only one
// snapshot per idle period, and never twice for the same viewport.
//
// It never reads what you type: keydown only resets the timer; no keys, no input values.
(() => {
  if (window.__docTraceRecorder) return; // injected twice (static + on start)
  window.__docTraceRecorder = true;

  const STATE_KEY = 'dtLiveState';
  const DEFAULT_DWELL_MS = 7000; // the service worker's live state normally sets it (liveRecorder.js DWELL_MS)
  let active = false;
  let dwellMs = DEFAULT_DWELL_MS;

  // ---- dwell timer ----
  let timer = null;
  let armed = true;          // false after a snapshot, until the user does something
  let epoch = 0;             // bumps on click/keydown: the screen may have changed in place
  let lastObserved = null;   // viewport signature of the last observe snapshot

  const viewportSig = () => [location.href, Math.round(scrollX), Math.round(scrollY), innerWidth, innerHeight, epoch].join('|');

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (active && armed && dwellMs > 0) timer = setTimeout(onDwell, dwellMs);
  }

  function onActivity(changesContent) {
    if (changesContent) epoch += 1;
    armed = true;
    schedule();
  }

  function onDwell() {
    timer = null;
    if (!active) return;
    // Only the tab the user is looking at; a background tab would capture the wrong screen.
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const sig = viewportSig();
    armed = false;
    if (sig === lastObserved) return; // exact same viewport as the last snapshot
    lastObserved = sig;
    chrome.runtime.sendMessage({
      type: 'SC_LIVE_OBSERVE',
      observe: {
        dpr: window.devicePixelRatio || 1,
        viewportWidth: window.innerWidth,
        pageTitle: clean(document.title),
        url: location.href,
        dwellTimeMs: dwellMs,
        timestamp: Date.now(),
      },
    }).catch(() => {});
  }

  // Banner when the microphone records only silence (wrong or disconnected mic).
  // Lives in a shadow root so the page's CSS cannot change or hide it.
  let banner = null;
  function showMicWarning(show, device) {
    if (!show) { banner?.remove(); banner = null; return; }
    if (banner) return;
    banner = document.createElement('div');
    const root = banner.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .b { position: fixed; top: 12px; right: 12px; z-index: 2147483647; max-width: 340px; padding: 10px 14px;
           background: #fff7e6; color: #5c3b00; border: 1px solid #e0a100; border-radius: 10px;
           font: 13px/1.45 system-ui, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.18); }
      b { display: block; margin-bottom: 2px; }
    </style><div class="b" role="alert"><b>DOCTrace: your microphone is silent</b></div>`;
    const msg = document.createElement('span');
    msg.textContent = `No sound from "${device || 'the microphone'}". Check it is connected and not muted, or pick another one in DOCTrace Settings.`;
    root.querySelector('.b').appendChild(msg);
    (document.body || document.documentElement).appendChild(banner);
  }

  function applyState(state) {
    active = Boolean(state?.active);
    dwellMs = Number.isFinite(state?.dwellMs) ? state.dwellMs : DEFAULT_DWELL_MS;
    if (active) schedule(); else { clearTimeout(timer); timer = null; }
    showMicWarning(active && state?.voice && state?.voiceSilent, state?.voiceDevice);
  }

  chrome.storage.local.get(STATE_KEY).then((d) => applyState(d[STATE_KEY])).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STATE_KEY]) applyState(changes[STATE_KEY].newValue);
  });

  document.addEventListener('keydown', () => onActivity(true), { capture: true, passive: true });
  document.addEventListener('scroll', () => onActivity(false), { capture: true, passive: true });
  window.addEventListener('resize', () => onActivity(false), { passive: true });
  window.addEventListener('hashchange', () => onActivity(true));
  window.addEventListener('popstate', () => onActivity(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onActivity(false); });

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);

  // The visible name of an element, never its typed value.
  function labelOf(el) {
    if (!el || el.nodeType !== 1) return '';
    const field = el.closest('input, textarea, select, [contenteditable="true"]');
    if (field) {
      const byFor = field.id ? document.querySelector(`label[for="${CSS.escape(field.id)}"]`) : null;
      return clean(field.getAttribute('aria-label') || byFor?.innerText || field.closest('label')?.innerText
        || field.getAttribute('placeholder') || field.getAttribute('name') || field.getAttribute('title'));
    }
    const control = el.closest('button, a, [role="button"], [role="tab"], [role="menuitem"], [role="link"], [role="option"], summary, label');
    const target = control || el;
    const text = clean(target.getAttribute('aria-label') || target.innerText || target.getAttribute('title') || target.getAttribute('alt'));
    // Plain page text (not a control) is only used when it is short, like a menu entry.
    // Otherwise the manual uses the OCR text under the click instead.
    return control || text.length <= 40 ? text : '';
  }

  function actionOf(el) {
    const field = el?.closest?.('input, textarea, select, [contenteditable="true"]');
    if (!field) return 'click';
    const t = (field.getAttribute('type') || '').toLowerCase();
    return ['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file'].includes(t) ? 'click' : 'input';
  }

  document.addEventListener('pointerdown', (e) => {
    if (active) onActivity(true); // any pointer press restarts the dwell timer
    if (!active || e.button !== 0 || !e.isTrusted) return;
    chrome.runtime.sendMessage({
      type: 'SC_LIVE_CLICK',
      click: {
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        dpr: window.devicePixelRatio || 1,
        viewportWidth: window.innerWidth,
        actionType: actionOf(e.target),
        targetLabel: labelOf(e.target),
        pageTitle: clean(document.title),
        url: location.href,
        timestamp: Date.now(),
      },
    }).catch(() => {});
  }, { capture: true, passive: true });
})();

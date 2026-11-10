// Popup: start/stop a recorded workflow, take a one-off protected screenshot,
// and jump to recent guides. The capture and all processing happen in the
// background (service worker + offscreen document). The popup only shows
// progress and the final protected image.

import { STORAGE_KEY, copyImage, dataUrlToBlob, downloadBlob, fileName, labelFor, timeAgo } from './lib/shared.js';
import { loadVoiceSettings, saveVoiceSettings } from '../group2/voice/voiceSettings.js';

const $ = (id) => document.getElementById(id);
const views = ['viewIdle', 'viewBusy', 'viewResult', 'viewError'];
const STAGES = {
  capturing: 'Capturing the page...',
  protecting: 'Finding and hiding sensitive information...',
};
const ICON_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a16 16 0 0 1-3.2 3.7M6.6 6.6C4.2 8.2 3 12 3 12s4 6 9 6a9 9 0 0 0 4.4-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
const ICON_DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h8l4 4v14H6z"/><path d="M9 12h6M9 16h4"/></svg>';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const openGuide = (sessionId) => chrome.tabs.create({ url: chrome.runtime.getURL(`ui/sessions.html${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`) });

let current = null;

function show(view) {
  for (const v of views) $(v).hidden = v !== view;
  $('btnCapture').disabled = view === 'viewBusy';
  $('captureLabel').textContent = view === 'viewResult' || view === 'viewError' ? 'New capture' : 'Capture';
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 1800);
}

// ---------- one-off screenshot ----------
function renderResult(rec) {
  current = rec;
  $('thumb').src = rec.imageDataUrl;
  const n = rec.regionCount;
  $('resultIcon').className = `result-icon ${n ? 'found' : 'clean'}`;
  $('resultIcon').innerHTML = n ? ICON_EYE_OFF : ICON_SHIELD;
  $('resultTitle').textContent = n ? `${n} sensitive item${n === 1 ? '' : 's'} hidden` : 'No sensitive information found';
  $('resultMeta').textContent = [rec.pageHost, timeAgo(rec.createdAt)].filter(Boolean).join(' · ');
  $('chips').innerHTML = Object.entries(rec.counts)
    .map(([type, count]) => `<span class="chip">${esc(labelFor(type))} <b>${count}</b></span>`).join('');
  show('viewResult');
}

function renderError(message) {
  $('errorText').textContent = message;
  show('viewError');
}

async function capture() {
  $('busyText').textContent = STAGES.capturing;
  show('viewBusy');
  const res = await chrome.runtime.sendMessage({ type: 'CAPTURE_ACTIVE_TAB' });
  if (!res?.ok) return renderError(res?.error || 'Capture failed.');
  const data = await chrome.storage.session.get(STORAGE_KEY);
  if (data[STORAGE_KEY]) renderResult(data[STORAGE_KEY]);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'CAPTURE_PROGRESS' && STAGES[msg.stage]) $('busyText').textContent = STAGES[msg.stage];
  if (['SC_SESSION_STARTED', 'SC_SESSION_DONE', 'SC_MANUAL_UPDATED'].includes(msg?.type)) renderRecent();
  return false; // never answer messages meant for other parts of the extension
});

$('btnCapture').addEventListener('click', () => capture().catch((e) => renderError(e.message)));
$('btnDownload').addEventListener('click', () => {
  if (current) downloadBlob(dataUrlToBlob(current.imageDataUrl), fileName(current.createdAt));
});
$('btnCopy').addEventListener('click', async () => {
  if (!current) return;
  try { await copyImage(dataUrlToBlob(current.imageDataUrl)); toast('Copied to clipboard'); } catch { toast('Could not copy'); }
});
const openViewer = () => chrome.tabs.create({ url: chrome.runtime.getURL('ui/viewer.html') });
$('btnOpen').addEventListener('click', openViewer);
$('thumbBtn').addEventListener('click', openViewer);
$('btnSessions').addEventListener('click', () => openGuide());
$('btnSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ---------- real-time recording ----------
let liveState = { active: false };
let timer = null;

function tick() {
  const s = Math.max(0, Math.floor((Date.now() - (liveState.startedAt || Date.now())) / 1000));
  $('recTimer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

async function renderRec() {
  const st = (await chrome.storage.local.get('dtLiveState')).dtLiveState || { active: false };
  liveState = st;
  const live = Boolean(st.active);
  $('recCard').classList.toggle('live', live);
  $('recLive').hidden = !live;
  $('btnRec').disabled = Boolean(st.stopping);
  $('recBtnLabel').textContent = live ? 'Stop & build guide' : (st.stopping ? 'Saving guide...' : 'Start recording');
  $('btnOpenLast').hidden = live || !st.lastSessionId;
  if (live) {
    $('recTitle').textContent = `${st.name} is recording`;
    $('recSub').textContent = st.voice && st.voiceSilent
      ? `Your microphone is silent ("${st.voiceDevice || 'unknown'}"). Check it, or stop and choose another microphone in Settings.`
      : st.voice
      ? 'Recording your voice. Talk through each step while you click.'
      : 'Click around the page. Each click is captured and protected. Voice is OFF for this recording.';
    $('recSteps').textContent = `${st.steps || 0} step${st.steps === 1 ? '' : 's'}`;
    tick();
    if (!timer) timer = setInterval(tick, 1000);
  } else {
    clearInterval(timer);
    timer = null;
    if (st.lastSessionId) {
      $('recTitle').textContent = `${st.lastName} saved`;
      $('recSub').textContent = `${st.lastSteps || 0} step${st.lastSteps === 1 ? '' : 's'} captured. Review and export your guide, or record a new one.`;
    } else {
      $('recTitle').textContent = 'Record a workflow';
      $('recSub').textContent = 'Click through your process. Every click becomes a guide step, with sensitive data hidden.';
    }
  }
  const folder = live ? st.folder : st.lastFolder;
  $('recFolder').hidden = !folder;
  $('recFolder').textContent = folder ? `${live ? 'Saving to' : 'Saved to'} ${folder}` : '';
}

$('btnRec').addEventListener('click', async () => {
  const st = (await chrome.storage.local.get('dtLiveState')).dtLiveState || {};
  $('btnRec').disabled = true;
  const res = await chrome.runtime.sendMessage({ type: st.active ? 'SC_LIVE_STOP' : 'SC_LIVE_START' });
  if (!res?.ok) toast(res?.error || 'Could not change recording');
  else if (!st.active) window.close(); // get the popup out of the way so you can start clicking
  $('btnRec').disabled = false;
  renderRec();
  renderRecent();
});
$('btnOpenLast').addEventListener('click', () => openGuide(liveState.lastSessionId));

// ---------- voice narration switch ----------
async function renderVoice() {
  const v = await loadVoiceSettings();
  $('voiceToggle').checked = v.enabled;
  $('voiceLabel').textContent = liveState.active
    ? (liveState.voice ? 'Voice: recording now' : 'Voice: off for this recording')
    : (v.enabled && !v.consent ? 'Record my voice (consent needed in Settings)' : 'Record my voice');
  $('voiceToggle').disabled = Boolean(liveState.active || liveState.stopping); // changes apply to the next recording
}
$('voiceToggle').addEventListener('change', async () => {
  const v = await saveVoiceSettings({ enabled: $('voiceToggle').checked });
  if (v.enabled && !v.consent) chrome.runtime.openOptionsPage(); // consent lives on the Options page
  renderVoice();
});
renderVoice();
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && c.dtLiveState) renderRec().then(renderVoice);
});
renderRec();

// ---------- recent guides ----------
async function renderRecent() {
  let all = [];
  try {
    const { listSessions } = await import('../group2/storage/sessionStore.js');
    all = await listSessions();
  } catch { /* storage not ready: show the empty state */ }
  $('recBadge').hidden = !all.some((s) => s.status === 'recording');
  const recent = all.slice(0, 3);
  $('recentEmpty').hidden = recent.length > 0;
  $('recentList').innerHTML = recent.map((s) => `
    <li><button class="recent-item" data-id="${esc(s.sessionId)}">
      <span class="doc-icon ${s.status === 'recording' ? 'recording' : ''}">${ICON_DOC}</span>
      <span><span class="t">${esc(s.sessionTitle || 'Untitled guide')}</span>
      <span class="m">${s.status === 'recording' ? 'Recording now' : `${s.totalSteps || 0} steps`} · ${esc(new Date(s.startTime).toLocaleDateString())}</span></span>
    </button></li>`).join('');
  for (const b of $('recentList').querySelectorAll('button')) b.addEventListener('click', () => openGuide(b.dataset.id));
}
renderRecent();

(async function init() {
  chrome.runtime.sendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' }).catch(() => null);
  if (status?.busy) {
    $('busyText').textContent = STAGES.protecting;
    show('viewBusy');
    return;
  }
  const data = await chrome.storage.session.get(STORAGE_KEY);
  if (data[STORAGE_KEY]) renderResult(data[STORAGE_KEY]);
  else show('viewIdle');
})();

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEY]?.newValue) renderResult(changes[STORAGE_KEY].newValue);
});

// Guides page: review recorded sessions as step-by-step guides, edit titles
// and step descriptions, generate the manual, and export (PDF, HTML, ZIP,
// Markdown). Only REDACTED images exist in storage.

import { listSessions, getSession, getSteps, updateStep, updateSession, deleteSession, buildManifest } from '../group2/storage/sessionStore.js';
import { downloadSessionZip, manualMarkdown } from '../group2/storage/exportZip.js';
import { blobToDataUrl, downloadBlob, labelFor } from './lib/shared.js';
import { esc, fallbackTitle, guideHtml, safeFileName } from './lib/guideExport.js';

const $ = (id) => document.getElementById(id);
let selected = new URLSearchParams(location.search).get('session');
let objectUrls = [];
let allSessions = [];
let pendingSave = Promise.resolve(); // exports wait for edits that are still being saved

const ICON_DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h8l4 4v14H6z"/><path d="M9 12h6M9 16h4"/></svg>';
const ICON_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>';
const ICON_STEPS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="4.5" cy="18" r="1.5"/></svg>';
const ICON_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICON_SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/></svg>';
const ICON_MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const ICON_SHIELD ='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/></svg>';

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2400);
}

const fmt = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const duration = (s) => {
  if (!s.endTime) return '';
  const sec = Math.max(1, Math.round((s.endTime - s.startTime) / 1000));
  return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min ${sec % 60} s`;
};
const autosize = (el) => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };

// ---------- sidebar ----------
function renderSidebar() {
  const q = $('search').value.trim().toLowerCase();
  const shown = allSessions.filter((s) => !q || (s.sessionTitle || '').toLowerCase().includes(q));
  $('listCount').textContent = allSessions.length ? `· ${allSessions.length}` : '';
  $('listEmpty').hidden = allSessions.length > 0;
  $('listEmpty').textContent = 'No guides yet. Start a recording and your guide appears here.';
  if (allSessions.length && !shown.length) { $('listEmpty').hidden = false; $('listEmpty').textContent = 'No guides match your search.'; }
  $('sessionList').innerHTML = shown.map((s) => `
    <li><button class="session-item ${s.sessionId === selected ? 'active' : ''}" data-id="${esc(s.sessionId)}">
      <span class="doc-icon">${ICON_DOC}</span>
      <span class="txt">
        <span class="t">${esc(s.sessionTitle || 'Untitled guide')}</span>
        <span class="m"><span class="status ${esc(s.status)}">${esc(s.status)}</span>${s.totalSteps || 0} steps · ${esc(new Date(s.startTime).toLocaleDateString())}</span>
      </span>
    </button></li>`).join('');
  for (const b of $('sessionList').querySelectorAll('button')) {
    b.addEventListener('click', () => { selected = b.dataset.id; history.replaceState(null, '', `?session=${encodeURIComponent(selected)}`); refresh(); window.scrollTo({ top: 0 }); });
  }
}

async function renderList() {
  allSessions = await listSessions();
  if (!selected && allSessions[0]) selected = allSessions[0].sessionId;
  renderSidebar();
}

// "What you said" on this step, shown right under its title. Only for guides
// recorded with voice; editable so a misheard word can be fixed.
function narrationBlock(s, ok, session) {
  if (!session?.voice) return '';
  const userWritten = s.descriptionSource === 'user';
  return `<div class="narration">
    <span class="narration-head">${ICON_MIC}<span>What you said</span>
      ${ok ? `<button class="btn btn-ghost btn-sm btn-rewrite" type="button" ${userWritten ? 'disabled title="You edited this step yourself, so it is not rewritten"' : 'title="Rewrite this step from what you said"'}>Rewrite</button>` : ''}
    </span>
    <textarea class="f-narration" rows="1" placeholder="Nothing was said on this step" aria-label="Step ${s.stepNumber} spoken narration" ${ok ? '' : 'disabled'}>${esc(s.narration || '')}</textarea>
  </div>`;
}

const progressText = (s) => (s.manualProgress?.total ? `${s.manualProgress.done} of ${s.manualProgress.total} steps done` : '');

// One labeled, editable part of a five-part step (Where / On this screen / Expected result).
function extraField(s, field, label, placeholder, ok) {
  return `<label class="extra"><span class="extra-label">${esc(label)}</span>
    <textarea class="f-extra" data-field="${field}" rows="1" placeholder="${esc(placeholder)}" aria-label="Step ${s.stepNumber} ${esc(label)}" ${ok ? '' : 'disabled'}>${esc(s[field] || '')}</textarea></label>`;
}

// ---------- document ----------
async function renderDetail() {
  if (!selected) { $('detail').hidden = true; $('outline').hidden = true; $('placeholder').hidden = false; return; }
  const session = await getSession(selected);
  if (!session) { selected = null; return renderDetail(); }
  $('placeholder').hidden = true;
  $('detail').hidden = false;
  if (document.activeElement !== $('dTitle')) $('dTitle').value = session.sessionTitle || '';
  if (document.activeElement !== $('dIntro')) { $('dIntro').value = session.manualIntro || ''; autosize($('dIntro')); }
  document.title = `${session.sessionTitle || 'Guide'} - DOCTrace`;

  const meta = [
    `<span>${ICON_CAL}${esc(fmt(session.startTime))}</span>`,
    `<span>${ICON_STEPS}${session.totalSteps || 0} steps${session.failedSteps ? ` (${session.failedSteps} not saved)` : ''}</span>`,
    duration(session) && `<span>${ICON_CLOCK}${esc(duration(session))}</span>`,
    session.saveToFolder && `<span title="Saved on this computer">${ICON_FOLDER}Downloads/DOCTrace/${esc(session.saveFolderName)}</span>`,
    session.manualGeneratedBy && `<span>${ICON_SPARK}Manual by ${esc(session.manualGeneratedBy)}</span>`,
    session.source === 'live-recorder' && `<span>${ICON_MIC}${esc(
      !session.voice ? 'No voice recorded'
        : session.voiceStatus === 'done' ? `Narration on ${session.voiceSteps || 0} step${session.voiceSteps === 1 ? '' : 's'}`
          : session.voiceStatus === 'error' ? 'Voice: see notice' : `Voice: ${session.voiceStatus || 'recorded'}`,
    )}</span>`,
  ].filter(Boolean);
  $('dMeta').innerHTML = meta.join('');

  // Redaction summary
  const pii = Object.entries(session.piiSummary || {});
  const hiddenSteps = pii.length ? Math.max(...pii.map(([, n]) => n)) : 0;
  $('dPrivacyTitle').textContent = pii.length
    ? `Sensitive information was hidden on ${hiddenSteps} step${hiddenSteps === 1 ? '' : 's'} before saving`
    : 'No sensitive information was found in these screenshots';
  $('dChips').innerHTML = pii.map(([t, n]) => `<span class="chip">${esc(labelFor(t))} <b>${n}</b></span>`).join('');
  $('dChips').hidden = !pii.length;

  // Status line + notice
  const status = { recording: 'Recording in progress', processing: 'Processing steps...', complete: 'All changes saved' }[session.status] || session.status;
  $('dStatus').innerHTML = session.status === 'recording'
    ? `<span class="rec-dot live"></span>${esc(status)}`
    : session.voiceStatus === 'transcribing' ? `<span class="spinner sm"></span>Transcribing your voice...`
    : session.manualStatus === 'generating' ? `<span class="spinner sm"></span>Writing step descriptions... ${esc(progressText(session))}` : esc(status);
  const notice = $('dNotice');
  notice.hidden = true;
  notice.className = 'notice';
  if (session.status === 'recording') { notice.hidden = false; notice.classList.add('live'); notice.textContent = 'Recording in progress. New steps appear here automatically as you click.'; }
  else if (session.voiceStatus === 'transcribing') { notice.hidden = false; notice.textContent = 'Transcribing your voice with Whisper... step descriptions are written next. Please wait before exporting.'; }
  else if (session.manualStatus === 'generating') {
    notice.hidden = false;
    notice.textContent = `Writing step descriptions... ${progressText(session)}. With the free tier this can take a few minutes. Please wait before exporting.`;
  }
  else if (session.manualTemplateSteps > 0 && session.manualLlmSteps > 0) {
    notice.hidden = false;
    notice.classList.add('warn');
    notice.textContent = `${session.manualTemplateSteps} step${session.manualTemplateSteps === 1 ? '' : 's'} used template descriptions; ${session.manualLlmSteps} were written by the LLM.${session.manualError ? ` ${session.manualError}` : ''}`;
  } else if (session.voiceError) {
    notice.hidden = false;
    notice.classList.add('warn');
    notice.textContent = `Voice narration: ${session.voiceError}`;
  } else if (session.manualError) {
    notice.hidden = false;
    notice.classList.add('warn');
    notice.textContent = `${session.manualError}${session.manualTemplateSteps ? ` Templates were used for ${session.manualTemplateSteps} step${session.manualTemplateSteps === 1 ? '' : 's'}.` : ''}`;
  }

  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
  const steps = await getSteps(selected, { withImages: true });
  $('steps').innerHTML = steps.length ? steps.map((s) => {
    const ok = s.status === 'redacted' && s.redactedBlob;
    let img;
    if (ok) {
      const u = URL.createObjectURL(s.redactedBlob);
      objectUrls.push(u);
      img = `<figure class="shot">
        <button class="shot-btn" data-src="${u}" data-n="${s.stepNumber}" title="View full size">
          <img src="${u}" alt="Step ${s.stepNumber} (protected)" loading="lazy">
          <span class="shot-tag">${ICON_SHIELD}Protected</span>
        </button>
        <figcaption>
          <div class="chips">${(s.detectedPiiSummary || []).map((t) => `<span class="chip">${esc(labelFor(t))} hidden</span>`).join('') || '<span class="muted small">No sensitive data on this step</span>'}</div>
          <span class="src ${s.descriptionSource === 'user' ? 'user' : s.descriptionSource && s.descriptionSource !== 'template' ? 'llm' : ''}">${s.descriptionSource ? `Written by ${esc(s.descriptionSource)}` : 'No description yet'}</span>
        </figcaption>
      </figure>`;
    } else {
      img = `<div class="failed-img"><div><b>Screenshot not saved</b>This step could not be protected, so its screenshot was discarded.<br>${esc(s.error || '')}</div></div>`;
    }
    return `<li class="step ${ok ? '' : 'failed'}" id="step-${s.stepNumber}" data-n="${s.stepNumber}">
      <span class="step-num">${s.stepNumber}</span>
      <div class="step-main">
        <div class="step-top">
          <input class="f-title" placeholder="${esc(fallbackTitle(s))}" value="${esc(s.manualTitle)}" aria-label="Step ${s.stepNumber} title" ${ok ? '' : 'disabled'}>
          <span class="badge">${esc(s.action)}</span>
        </div>
        ${narrationBlock(s, ok, session)}
        <textarea class="f-desc" rows="1" placeholder="Add an instruction for this step" aria-label="Step ${s.stepNumber} instruction" ${ok ? '' : 'disabled'}>${esc(s.manualDescription)}</textarea>
        ${extraField(s, 'manualUiLandmarks', 'Where', 'Where the element is on the screen', ok)}
        ${img}
        ${extraField(s, 'manualScreenContext', 'On this screen', 'What this screen shows', ok)}
        ${extraField(s, 'manualExpectedOutcome', 'Expected result', 'What happens after this step', ok)}
        ${extraField(s, 'manualNote', 'Note', 'Tips or requirements (for example: only ZIP and PDF files)', ok)}
        <span class="saved" hidden>Saved</span>
      </div>
    </li>`;
  }).join('') : '<li class="muted">No steps yet. Click around the page you are recording and steps will appear here.</li>';

  for (const li of $('steps').querySelectorAll('.step')) {
    const n = Number(li.dataset.n);
    const desc = li.querySelector('.f-desc');
    const extras = [...li.querySelectorAll('.f-extra')];
    for (const el of [desc, ...extras]) {
      autosize(el);
      el.addEventListener('input', () => autosize(el));
    }
    const save = () => {
      pendingSave = pendingSave.then(async () => {
        await updateStep(selected, n, {
          manualTitle: li.querySelector('.f-title').value.trim(),
          manualDescription: desc.value.trim(),
          ...Object.fromEntries(extras.map((el) => [el.dataset.field, el.value.trim()])),
          descriptionSource: 'user',
        });
        const s = li.querySelector('.saved');
        s.hidden = false;
        setTimeout(() => { s.hidden = true; }, 1200);
        const src = li.querySelector('.src');
        if (src) { src.textContent = 'Written by user'; src.className = 'src user'; }
        renderOutline();
      }).catch((err) => toast(`Not saved: ${err.message}`));
      return pendingSave;
    };
    li.querySelector('.f-title').addEventListener('change', save);
    desc.addEventListener('change', save);
    for (const el of extras) el.addEventListener('change', save);

    // Spoken narration: fixing a misheard word is NOT a hand-written description,
    // so the step stays AI-written and "Rewrite" can use the corrected words.
    const narr = li.querySelector('.f-narration');
    if (narr) {
      autosize(narr);
      narr.addEventListener('input', () => autosize(narr));
      narr.addEventListener('change', () => {
        pendingSave = pendingSave.then(() => updateStep(selected, n, { narration: narr.value.trim(), narrationEdited: true }))
          .then(() => toast('Narration saved. Click Rewrite to update this step from it.'))
          .catch((err) => toast(`Not saved: ${err.message}`));
      });
    }
    li.querySelector('.btn-rewrite')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      await pendingSave;
      btn.disabled = true;
      btn.textContent = 'Rewriting...';
      const res = await chrome.runtime.sendMessage({ type: 'SC_STEP_REWRITE', sessionId: selected, stepNumber: n }).catch((err) => ({ ok: false, error: err.message }));
      btn.disabled = false;
      btn.textContent = 'Rewrite';
      if (!res?.ok) toast(res?.error || 'Could not rewrite this step');
      else if (res.source !== 'llm') toast(res.error || 'The AI was not available; a template was used.');
      refresh();
    });
  }
  for (const b of $('steps').querySelectorAll('.shot-btn')) {
    b.addEventListener('click', () => openLightbox(b.dataset.src, `Step ${b.dataset.n}`));
  }
  renderOutline();
}

function renderOutline() {
  const items = [...$('steps').querySelectorAll('.step')];
  $('outline').hidden = items.length === 0;
  $('outlineList').innerHTML = items.map((li) => {
    const t = li.querySelector('.f-title');
    return `<li><a href="#step-${li.dataset.n}" data-n="${li.dataset.n}"><b>${li.dataset.n}</b><span>${esc(t.value || t.placeholder)}</span></a></li>`;
  }).join('');
  observeSteps(items);
}

let observer = null;
function observeSteps(items) {
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      for (const a of $('outlineList').querySelectorAll('a')) a.classList.toggle('active', a.dataset.n === e.target.dataset.n);
    }
  }, { rootMargin: '-140px 0px -60% 0px' });
  for (const li of items) observer.observe(li);
}

async function refresh() {
  await renderList();
  // Do not redraw the steps while the user is typing in one of them.
  if ($('steps').contains(document.activeElement)) return;
  await renderDetail();
}

// ---------- title ----------
$('dTitle').addEventListener('change', async () => {
  if (!selected) return;
  const title = $('dTitle').value.trim();
  if (!title) { const s = await getSession(selected); $('dTitle').value = s?.sessionTitle || ''; return; }
  pendingSave = pendingSave.then(() => updateSession(selected, { sessionTitle: title })).catch((err) => toast(`Not saved: ${err.message}`));
  await pendingSave;
  toast('Title saved');
  renderList();
});
$('dTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.currentTarget.blur(); });
$('search').addEventListener('input', renderSidebar);

// Guide introduction: editable. Once you edit it, regenerating the manual never replaces it
// (clear the box to let the AI write it again).
$('dIntro').addEventListener('input', () => autosize($('dIntro')));
$('dIntro').addEventListener('change', () => {
  if (!selected) return;
  const text = $('dIntro').value.trim();
  pendingSave = pendingSave.then(() => updateSession(selected, { manualIntro: text, manualIntroSource: text ? 'user' : null }))
    .then(() => toast('Introduction saved'))
    .catch((err) => toast(`Not saved: ${err.message}`));
});

// ---------- lightbox ----------
function openLightbox(src, caption) {
  $('lbImg').src = src;
  $('lbCaption').textContent = `${caption} · sensitive information hidden`;
  $('lightbox').hidden = false;
  $('lbClose').focus();
}
const closeLightbox = () => { $('lightbox').hidden = true; $('lbImg').removeAttribute('src'); };
$('lbClose').addEventListener('click', closeLightbox);
$('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeLightbox(); });

// ---------- export ----------
const menu = $('exportMenu');
const setMenu = (open) => { menu.hidden = !open; $('btnExportMenu').setAttribute('aria-expanded', String(open)); };
$('btnExportMenu').addEventListener('click', (e) => { e.stopPropagation(); setMenu(menu.hidden); });
document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMenu(false); closeLightbox(); } });

async function buildGuideHtml() {
  await pendingSave;
  const session = await getSession(selected);
  const steps = await getSteps(selected, { withImages: true });
  const withImages = await Promise.all(steps.map(async (s) => ({
    ...s,
    imageSrc: s.status === 'redacted' && s.redactedBlob instanceof Blob ? await blobToDataUrl(s.redactedBlob) : null,
  })));
  return { session, html: guideHtml(session, withImages) };
}

async function exportAction(fn) {
  if (!selected) return;
  setMenu(false);
  const s = await getSession(selected);
  if (s?.voiceStatus === 'transcribing' || s?.manualStatus === 'generating') {
    const what = s.voiceStatus === 'transcribing' ? 'Your voice is still being transcribed' : `Step descriptions are still being written (${progressText(s) || 'in progress'})`;
    if (!confirm(`${what}. Exporting now gives an unfinished guide. Export anyway?`)) return;
  }
  try { await fn(); } catch (err) { toast(`Export failed: ${err.message}`); }
}

$('btnPdf').addEventListener('click', () => exportAction(async () => {
  const { html } = await buildGuideHtml();
  const frame = $('printFrame');
  await new Promise((resolve) => { frame.onload = resolve; frame.srcdoc = html; });
  frame.contentWindow.focus();
  frame.contentWindow.print(); // the print dialog offers "Save as PDF"
}));
$('btnHtml').addEventListener('click', () => exportAction(async () => {
  const { session, html } = await buildGuideHtml();
  downloadBlob(new Blob([html], { type: 'text/html' }), safeFileName(session.sessionTitle, 'html'));
  toast('HTML guide downloaded');
}));
$('btnExport').addEventListener('click', () => exportAction(async () => {
  await pendingSave;
  toast(`Downloaded ${await downloadSessionZip(selected)}`);
}));
$('btnMarkdown').addEventListener('click', () => exportAction(async () => {
  await pendingSave;
  await navigator.clipboard.writeText(manualMarkdown(await buildManifest(selected)));
  toast('Markdown copied to clipboard');
}));

$('btnFolder').addEventListener('click', async () => {
  if (!selected) return;
  await pendingSave;
  const res = await chrome.runtime.sendMessage({ type: 'SC_SAVE_FOLDER', sessionId: selected });
  toast(res?.ok ? `Saved to Downloads/${res.folder}` : (res?.error || 'Could not save'));
});

$('btnGenerate').addEventListener('click', async () => {
  if (!selected) return;
  const b = $('btnGenerate');
  b.disabled = true;
  $('genLabel').textContent = 'Generating...';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SC_MANUAL_GENERATE', sessionId: selected });
    if (!res?.ok) toast(res?.error || 'Generation failed');
    else toast(res.llmSteps ? `${res.llmSteps} steps written by ${res.provider}` : 'Template descriptions written (LLM is off or failed)');
  } finally {
    b.disabled = false;
    $('genLabel').textContent = 'Generate manual';
    renderDetail();
  }
});

$('btnDelete').addEventListener('click', async () => {
  if (!selected || !confirm('Delete this guide and all its protected screenshots?')) return;
  await deleteSession(selected);
  selected = null;
  history.replaceState(null, '', location.pathname);
  refresh();
});

// ---------- recording control ----------
let live = { active: false };
async function renderLive() {
  live = (await chrome.storage.local.get('dtLiveState')).dtLiveState || { active: false };
  $('btnLive').className = `btn ${live.active ? 'btn-danger' : 'btn-primary'}`;
  $('liveDot').className = `rec-dot ${live.active ? 'live' : ''}`;
  $('liveLabel').textContent = live.active ? `Stop ${live.name} · ${live.steps || 0} steps` : (live.stopping ? 'Saving...' : 'New recording');
  $('btnLive').disabled = Boolean(live.stopping);
}
async function toggleLive() {
  $('btnLive').disabled = true;
  const wasActive = live.active;
  const res = await chrome.runtime.sendMessage({ type: wasActive ? 'SC_LIVE_STOP' : 'SC_LIVE_START' });
  if (!res?.ok) toast(res?.error || 'Could not change recording');
  else if (!wasActive) { selected = res.sessionId; history.replaceState(null, '', `?session=${encodeURIComponent(selected)}`); toast('Recording started. Switch to the tab you want to record and click through your workflow.'); }
  await renderLive();
  refresh();
}
$('btnLive').addEventListener('click', toggleLive);
$('btnEmptyRec').addEventListener('click', toggleLive);
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.dtLiveState) renderLive(); });
renderLive();

let pending = null;
chrome.runtime.onMessage.addListener((msg) => {
  if (['SC_STEP_DONE', 'SC_SESSION_DONE', 'SC_SESSION_STARTED', 'SC_MANUAL_UPDATED'].includes(msg?.type)) {
    clearTimeout(pending);
    pending = setTimeout(refresh, 250); // group bursts of updates
  }
  return false;
});

chrome.runtime.sendMessage({ type: 'SC_MANUAL_RECOVER' })
  .then((result) => {
    if (!result?.ok) toast('Could not recover interrupted guide generation.');
    return refresh();
  })
  .catch(() => toast('Could not check for interrupted guide generation.'));
refresh();

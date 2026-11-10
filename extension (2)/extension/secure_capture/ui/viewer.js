// Full-size view of the last protected capture. Only the redacted image is
// available here; the original screenshot was never stored.

import { STORAGE_KEY, copyImage, dataUrlToBlob, downloadBlob, fileName, labelFor, timeAgo } from './lib/shared.js';

const $ = (id) => document.getElementById(id);
let current = null;

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 1800);
}

function showEmpty(title, text, isError = false) {
  $('stage').hidden = true;
  $('panel').hidden = true;
  $('actions').hidden = true;
  $('empty').hidden = false;
  $('emptyTitle').textContent = title;
  if (text) $('emptyText').textContent = text;
  $('empty').firstElementChild.classList.toggle('error', isError);
}

function render(rec) {
  current = rec;
  $('empty').hidden = true;
  $('stage').hidden = false;
  $('panel').hidden = false;
  $('actions').hidden = false;
  $('image').src = rec.imageDataUrl;

  const n = rec.regionCount;
  $('summaryTitle').textContent = n ? `${n} item${n === 1 ? '' : 's'} hidden` : 'Nothing sensitive found';
  $('summaryMeta').textContent = `Captured ${timeAgo(rec.createdAt)}`;
  $('typesBlock').hidden = !n;
  $('typeList').innerHTML = Object.entries(rec.counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `<li><span>${labelFor(type)}</span><span class="count">${count}</span></li>`).join('');
  $('factPage').textContent = rec.pageTitle || rec.pageHost || 'Unknown page';
  $('factPage').title = rec.pageHost;
  $('factSize').textContent = `${rec.width} x ${rec.height} px`;
  $('factWords').textContent = `${rec.wordCount} words`;
  document.title = `${n ? n + ' hidden' : 'Protected'} - ${rec.pageHost || 'capture'}`;
}

$('btnDownload').addEventListener('click', () => {
  if (current) downloadBlob(dataUrlToBlob(current.imageDataUrl), fileName(current.createdAt));
});
$('btnCopy').addEventListener('click', async () => {
  if (!current) return;
  try { await copyImage(dataUrlToBlob(current.imageDataUrl)); toast('Copied to clipboard'); } catch { toast('Could not copy'); }
});

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEY]?.newValue) render(changes[STORAGE_KEY].newValue);
});

(async function init() {
  const error = new URLSearchParams(location.search).get('error');
  if (error) return showEmpty('Capture not saved', error, true);
  const data = await chrome.storage.session.get(STORAGE_KEY);
  if (data[STORAGE_KEY]) render(data[STORAGE_KEY]);
  else showEmpty('No capture yet');
})();

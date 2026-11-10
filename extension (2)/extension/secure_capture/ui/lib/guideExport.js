// Builds a self-contained, printable HTML guide from a recorded session.
// Used by the guides page for "Export > HTML page" and "Export > PDF" (the
// same document is printed from a hidden frame). Only REDACTED screenshots
// and the scrubbed / user-written step text ever reach this function.

import { labelFor } from './shared.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Title used when a step has none yet ("Click 'Save'"). */
export function fallbackTitle(step) {
  const label = (step.targetLabel || '').trim();
  if (step.action === 'observe') return 'Review the page';
  if (step.action === 'complete') return 'Task complete';
  if (step.action === 'input') return label ? `Type in "${label}"` : 'Type into the field';
  if (step.action === 'navigate') return 'Go to the page';
  return label ? `Click "${label}"` : 'Click on the highlighted area';
}

/**
 * @param session  session record from sessionStore
 * @param steps    [{ stepNumber, action, status, manualTitle, manualDescription,
 *                    manualScreenContext, manualUiLandmarks, manualExpectedOutcome,
 *                    targetLabel, detectedPiiSummary, imageSrc }]  imageSrc = data URL or null
 */
export function guideHtml(session, steps) {
  const title = session.sessionTitle || 'Untitled guide';
  const date = session.startTime ? new Date(session.startTime).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  const hiddenTypes = Object.keys(session.piiSummary || {});
  const body = steps.map((s) => {
    const heading = s.manualTitle || fallbackTitle(s);
    // What was said on this step, bound to it (scrubbed transcript).
    const said = s.narration ? `<blockquote class="said"><span class="said-label">Narration</span>&ldquo;${esc(s.narration)}&rdquo;</blockquote>` : '';
    const desc = s.manualDescription ? `<p class="desc">${esc(s.manualDescription)}</p>` : '';
    const where = s.manualUiLandmarks ? `<p class="where"><span class="tag">Where</span>${esc(s.manualUiLandmarks)}</p>` : '';
    const img = s.imageSrc
      ? `<img src="${s.imageSrc}" alt="Step ${s.stepNumber} screenshot (sensitive information hidden)">`
      : '<div class="missing">This step could not be protected, so its screenshot was not saved.</div>';
    const notes = [
      s.manualScreenContext && `<div class="note"><dt>On this screen</dt><dd>${esc(s.manualScreenContext)}</dd></div>`,
      s.manualExpectedOutcome && `<div class="note outcome"><dt>Expected result</dt><dd>${esc(s.manualExpectedOutcome)}</dd></div>`,
      s.manualNote && `<div class="note tip"><dt>Note</dt><dd>${esc(s.manualNote)}</dd></div>`,
    ].filter(Boolean).join('');
    const pii = (s.detectedPiiSummary || []).length
      ? `<div class="pii">Hidden on this step: ${s.detectedPiiSummary.map((t) => esc(labelFor(t))).join(', ')}</div>` : '';
    const kind = s.action === 'complete' ? ' final' : '';
    return `<section class="step${kind}"><div class="head"><span class="num">${s.stepNumber}</span><h2>${esc(heading)}</h2></div>${said}${desc}${where}<figure>${img}</figure>${notes ? `<dl class="notes">${notes}</dl>` : ''}${pii}</section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f5f6fa; color: #14161f; font: 15px/1.55 "Segoe UI", system-ui, -apple-system, Roboto, sans-serif; }
  .page { max-width: 820px; margin: 0 auto; padding: 48px 24px 64px; }
  header { margin-bottom: 28px; }
  h1 { margin: 0 0 8px; font-size: 30px; letter-spacing: -.02em; line-height: 1.2; }
  .meta { color: #6a7085; font-size: 13px; }
  .intro { margin: 14px 0 0; font-size: 16px; line-height: 1.6; color: #2b3040; }
  .said { margin: 10px 0 0 44px; padding: 8px 12px; border-left: 3px solid #5046e5; border-radius: 0 10px 10px 0; background: #f3f2ff; color: #3b4052; font-style: italic; font-size: 14px; }
  .said.intro-said { margin-left: 0; }
  .said-label { display: block; margin-bottom: 2px; font-style: normal; font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: #6a6fc4; }
  .privacy { margin-top: 14px; padding: 10px 14px; border-radius: 10px; background: #e5f5ec; color: #157a4c; font-size: 13px; }
  .step { background: #fff; border: 1px solid #e4e6ee; border-radius: 14px; padding: 22px 24px; margin-bottom: 18px; break-inside: avoid; page-break-inside: avoid; }
  .head { display: flex; align-items: center; gap: 12px; }
  .num { width: 32px; height: 32px; flex: none; border-radius: 50%; background: #5046e5; color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 14px; }
  h2 { margin: 0; font-size: 17px; line-height: 1.35; }
  .desc { margin: 10px 0 0 44px; color: #14161f; font-size: 15.5px; font-weight: 500; white-space: pre-wrap; }
  .where { margin: 6px 0 0 44px; color: #4b5166; font-size: 13.5px; }
  .tag { display: inline-block; margin-right: 8px; padding: 1px 8px; border-radius: 999px; background: #eeedfd; color: #4038c9; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .notes { margin: 14px 0 0; display: grid; gap: 8px; }
  .note { padding: 10px 14px; border-radius: 10px; background: #f5f6fa; border-left: 3px solid #c9cbe0; }
  .note.outcome { background: #eef8f2; border-left-color: #2f9e6a; }
  .note.tip { background: #fff7e6; border-left-color: #e0a100; }
  .note dt { font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: #6a7085; }
  .note dd { margin: 2px 0 0; color: #2b3040; font-size: 14px; }
  .step.final .num { background: #2f9e6a; }
  figure { margin: 14px 0 0; }
  figure img { display: block; width: 100%; height: auto; border: 1px solid #e4e6ee; border-radius: 10px; }
  .missing { padding: 28px; text-align: center; color: #6a7085; background: #f2f3f8; border: 1px dashed #d3d6e2; border-radius: 10px; font-size: 13px; }
  .pii { margin-top: 8px; font-size: 12px; color: #6a7085; }
  footer { margin-top: 28px; text-align: center; color: #6a7085; font-size: 12px; }
  @media print {
    body { background: #fff; }
    .page { padding: 0; max-width: none; }
    .step { border: 0; padding: 0 0 18px; border-bottom: 1px solid #e4e6ee; border-radius: 0; }
    @page { margin: 16mm; }
  }
</style></head>
<body><div class="page">
<header>
  <h1>${esc(title)}</h1>
  <div class="meta">${esc([date, `${steps.length} step${steps.length === 1 ? '' : 's'}`].filter(Boolean).join(' · '))}</div>
  ${session.manualIntro ? `<p class="intro">${esc(session.manualIntro)}</p>` : ''}
  ${session.narrationIntro ? `<blockquote class="said intro-said"><span class="said-label">Narration</span>&ldquo;${esc(session.narrationIntro)}&rdquo;</blockquote>` : ''}
  <div class="privacy">${hiddenTypes.length ? `Sensitive information (${esc(hiddenTypes.map(labelFor).join(', '))}) was blacked out on the device before saving.` : 'Screenshots were checked on the device for sensitive information before saving.'}</div>
</header>
${body}
<footer>Created with DOCTrace</footer>
</div></body></html>`;
}

export function safeFileName(title, ext) {
  const base = String(title || 'guide').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'guide';
  return `${base}.${ext}`;
}

// Export one recorded session as a .zip:
//   manual_manifest.json      structured manifest (no raw text, no raw images)
//   manual.md                 readable tutorial (title, steps, images)
//   steps/step_1.png ...      REDACTED screenshots only
//
// Needs JSZip (bundled at group2/vendor/jszip/jszip.min.js). Load it with a
// classic <script> tag before this module, or pass the JSZip class in.
// Runs in an extension page (sessions page). No network, no extra permission:
// the download is a local blob link.

import { buildManifest, getSteps, getAudio, getSession } from './sessionStore.js';

export function manualMarkdown(manifest) {
  const lines = [`# ${manifest.sessionTitle || 'Recorded tutorial'}`, ''];
  if (manifest.startTime) lines.push(`Recorded ${new Date(manifest.startTime).toLocaleString()}`, '');
  if (manifest.intro) lines.push(manifest.intro, '');
  const spokenIntro = manifest.guideIntroNarration ?? manifest.spokenIntro;
  if (spokenIntro) lines.push(`> 🎙 *"${spokenIntro}"*`, '');
  for (const s of manifest.steps) {
    const stepTitle = s.stepTitle || s.manualTitle;
    lines.push(`## Step ${s.stepNumber}${stepTitle ? `: ${stepTitle}` : ''}`, '');
    const said = s.spokenNarration ?? s.narration;
    if (said) lines.push(`> 🎙 *"${said}"*`, '');
    lines.push(s.instruction || s.stepDescription || s.manualDescription || `(${s.action}) ${s.targetLabel || ''}`.trim(), '');
    const where = s.whereToFindIt ?? s.uiLandmarks;
    if (where) lines.push(`**Where:** ${where}`, '');
    if (s.redactedImageFileName) lines.push(`![Step ${s.stepNumber}](steps/${s.redactedImageFileName})`, '');
    else lines.push('_Screenshot not available: this step could not be protected, so it was not saved._', '');
    if (s.screenContext) lines.push(`**On this screen:** ${s.screenContext}`, '');
    if (s.expectedOutcome) lines.push(`**Expected result:** ${s.expectedOutcome}`, '');
    if (s.note) lines.push(`> **Note:** ${s.note}`, '');
  }
  return lines.join('\n');
}

export async function buildSessionZip(sessionId, JSZipClass = globalThis.JSZip) {
  if (!JSZipClass) throw new Error('JSZip is not loaded');
  const manifest = await buildManifest(sessionId);
  const steps = await getSteps(sessionId, { withImages: true });
  const zip = new JSZipClass();
  zip.file('manual_manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('manual.md', manualMarkdown(manifest));
  const folder = zip.folder('steps');
  for (const s of steps) {
    if (s.status === 'redacted' && s.redactedBlob instanceof Blob) {
      folder.file(s.redactedImageFileName, s.redactedBlob);
    }
  }
  // Voice narration: the original audio (NOT scrubbed; the user agreed to keep and
  // export it) and the scrubbed transcript.
  const audio = await getAudio(sessionId);
  audio.forEach((a, i) => {
    const ext = /ogg/.test(a.mimeType) ? 'ogg' : 'webm';
    zip.file(audio.length === 1 ? `narration.${ext}` : `narration_${i + 1}.${ext}`, a.blob);
  });
  const session = await getSession(sessionId);
  if (session?.transcript) zip.file('transcript.txt', session.transcript);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const safe = (manifest.sessionTitle || 'session').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'session';
  return { blob, fileName: `${safe}_${sessionId.slice(0, 8)}.zip`, manifest };
}

export async function downloadSessionZip(sessionId) {
  const { blob, fileName } = await buildSessionZip(sessionId);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return fileName;
}

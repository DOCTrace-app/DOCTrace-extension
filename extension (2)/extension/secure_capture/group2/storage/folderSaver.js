// Save recordings as real files on the computer, using chrome.downloads.
//
//   Downloads\DOCTrace\Recording 3\step_1.png
//                                      \step_2.png
//                                      \manual_manifest.json
//                                      \manual.md
//
// Chrome only lets an extension save automatically INSIDE the Downloads
// folder, so this is the location. Only REDACTED images are ever written.
// Runs in the service worker (data: URLs, because a service worker has no
// URL.createObjectURL).

import { buildManifest, getSession, getStep } from './sessionStore.js';
import { manualMarkdown } from './exportZip.js';
import { blobToWire } from '../bridge/blobCodec.js';
import { platform } from '../platform/platform.js';

export const ROOT_FOLDER = 'DOCTrace';

const safeName = (s) => String(s).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Recording';

export function folderFor(session) {
  return `${ROOT_FOLDER}/${safeName(session.saveFolderName || session.sessionTitle)}`;
}

// Through the platform adapter: Chrome writes into Downloads, a desktop build into its own folder.
async function save(filename, dataUrl) {
  return platform.files.save(filename, dataUrl);
}

const textUrl = (text, type) => `data:${type};charset=utf-8,${encodeURIComponent(text)}`;

/** Write one redacted step image. Failed steps have no image, so nothing is written. */
export async function saveStepImage(sessionId, stepNumber) {
  const session = await getSession(sessionId);
  const step = await getStep(sessionId, stepNumber);
  if (!session?.saveToFolder || !step || step.status !== 'redacted' || !(step.redactedBlob instanceof Blob)) return null;
  const wire = await blobToWire(step.redactedBlob);
  return save(`${folderFor(session)}/${step.redactedImageFileName}`, `data:${wire.type};base64,${wire.base64}`);
}

/** Write (or rewrite) manual_manifest.json and manual.md for a session. */
export async function saveManualFiles(sessionId) {
  const session = await getSession(sessionId);
  if (!session) return null;
  const manifest = await buildManifest(sessionId);
  const folder = folderFor(session);
  await save(`${folder}/manual_manifest.json`, textUrl(JSON.stringify(manifest, null, 2), 'application/json'));
  await save(`${folder}/manual.md`, textUrl(manualMarkdown(manifest), 'text/markdown'));
  return folder;
}

/** Write everything again (used by "Save to folder" on the Sessions page). */
export async function saveWholeSession(sessionId) {
  const manifest = await buildManifest(sessionId);
  for (const s of manifest.steps) if (s.redactedImageFileName) await saveStepImage(sessionId, s.stepNumber);
  return saveManualFiles(sessionId);
}

// Hide Chrome's download bubble while a recording writes many files.
export async function setDownloadBubble(visible) {
  await platform.files.setQuiet(!visible);
}

// EXAMPLE ONLY. This file is not imported by anything.
// It shows Group 1 how to call Group 2 from their service worker.
// Group 1 owns their own files; copy the idea, not this file.

import { processFrameInOffscreen } from './bridge/offscreenClient.js';
import { isUploadable, getUploadPayload } from './privacy/guard.js';

export async function handleRawFrame(rawFrame, saveFrame /* Group 1's db.js function */) {
  // rawFrame = { frameId, sessionId, tMs, eventId, width, height, dpr, imageBlob, status: "raw" }
  const result = await processFrameInOffscreen(rawFrame);

  if (result.status === 'redacted') {
    await saveFrame(result);                 // store in scribeDB (Group 1)
    const safe = getUploadPayload(result);   // no raw imageBlob inside
    return safe;
  }

  // status "failed": keep it out of the recording and never upload it.
  console.warn('Group 2 could not redact frame', result.frameId, result.error);
  if (isUploadable(result)) throw new Error('unreachable: failed frame is never uploadable');
  return null;
}

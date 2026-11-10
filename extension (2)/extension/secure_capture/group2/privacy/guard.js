// Privacy gate. Group 1 can call these before storing a frame as the final
// recording or before any upload. Only status === "redacted" passes.
//
//   isUploadable(frame)      -> true / false
//   assertUploadable(frame)  -> throws if the frame is not safe
//   getUploadPayload(frame)  -> a NEW object without imageBlob (raw pixels),
//                               safe to send. Throws if not redacted.

export function isUploadable(frame) {
  return Boolean(
    frame
    && frame.status === 'redacted'
    && frame.redactedBlob instanceof Blob
    && frame.redactedBlob.size > 0
    && Array.isArray(frame.piiRegions),
  );
}

export function assertUploadable(frame) {
  if (!isUploadable(frame)) {
    throw new Error(`Privacy gate: frame ${frame?.frameId ?? '?'} is "${frame?.status ?? 'unknown'}", only "redacted" frames may be stored or uploaded`);
  }
}

export function getUploadPayload(frame) {
  assertUploadable(frame);
  // Copy only safe fields. imageBlob (raw screenshot) and debug are left out.
  // The original frame object is not changed.
  return {
    frameId: frame.frameId,
    sessionId: frame.sessionId,
    tMs: frame.tMs,
    eventId: frame.eventId,
    width: frame.width,
    height: frame.height,
    dpr: frame.dpr,
    ocrText: frame.ocrText,
    piiRegions: frame.piiRegions,
    redactedBlob: frame.redactedBlob,
    status: frame.status,
  };
}

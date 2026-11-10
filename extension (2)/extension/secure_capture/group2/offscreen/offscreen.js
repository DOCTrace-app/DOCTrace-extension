// Runs inside the offscreen document (hidden page, has Web Workers + canvas).
// It handles two kinds of work, both 100% local:
//   1. GROUP2_PROCESS_FRAME  single screenshot (popup / shortcut capture)
//   2. REC_*                 recorded sessions from the partner recorder
//                            (queued, processed in order, stored in scribeDB)
// Raw images arrive here and never leave: replies carry only results.

import { processFrame } from '../pipeline.js';
import { blobToWire, wireToBlob, isWireBlob } from '../bridge/blobCodec.js';
import { startSession, enqueueFrame, endSession, getStatus } from '../recorder/recorderService.js';
import { isAllowedLlmUrl } from '../bridge/llmFetch.js';
import { micPermission, startVoice, stopVoice, voiceStatus } from '../voice/voiceRecorder.js';
import { transcribeSession, transcribeAudio, alignSession } from '../voice/voiceTranscriber.js';

export const OFFSCREEN_TARGET = 'group2-offscreen';

const errorReply = (err) => ({ ok: false, code: err?.code || 'ERROR', error: String(err?.message || err), retryAfterMs: err?.retryAfterMs });

const handlers = {
  GROUP2_PING: async () => ({ ok: true }),

  GROUP2_PROCESS_FRAME: async (msg) => {
    const frame = { ...msg.frame };
    if (isWireBlob(frame.imageBlob)) frame.imageBlob = wireToBlob(frame.imageBlob);
    const result = await processFrame(frame);
    const reply = { ...result };
    delete reply.imageBlob; // the caller already has the original, do not send it back
    if (reply.redactedBlob instanceof Blob) reply.redactedBlob = await blobToWire(reply.redactedBlob);
    return { ok: true, frame: reply };
  },

  REC_START: async (msg) => ({ ok: true, ...(await startSession(msg.session)) }),

  REC_FRAME: async (msg) => {
    const payload = { ...msg.frame };
    if (isWireBlob(payload.imageBlob)) payload.imageBlob = wireToBlob(payload.imageBlob);
    return { ok: true, ...(await enqueueFrame(payload)) }; // answers at once; work continues in the queue
  },

  REC_END: async (msg) => ({ ok: true, ...(await endSession(msg.session)) }),

  REC_STATUS: async (msg) => ({ ok: true, session: await getStatus(msg.sessionId) }),

  // Voice narration (microphone works here, not in the service worker).
  VOICE_PERMISSION: async () => ({ ok: true, state: await micPermission() }),
  VOICE_START: async (msg) => startVoice(String(msg.sessionId), { deviceId: msg.deviceId || '' }),
  VOICE_STOP: async (msg) => stopVoice(msg.sessionId ? String(msg.sessionId) : undefined),
  VOICE_STATUS: async () => ({ ok: true, ...voiceStatus() }),
  VOICE_TRANSCRIBE: async (msg) => transcribeSession(String(msg.sessionId), { apiKey: msg.apiKey, model: msg.model || undefined, matching: msg.matching }),
  VOICE_TRANSCRIBE_AUDIO: async (msg) => transcribeAudio(String(msg.sessionId), { apiKey: msg.apiKey, model: msg.model || undefined }),
  VOICE_ALIGN: async (msg) => alignSession(String(msg.sessionId), { matching: msg.matching }),

  // LLM request proxy (see bridge/llmFetch.js). The service worker is killed if
  // one of its fetch() calls waits more than 30 s, and vision models can take
  // longer. This page has no such limit. The body was already built and
  // privacy-guarded by the caller (scrubbed text + REDACTED images only).
  LLM_FETCH: async (msg) => {
    if (!isAllowedLlmUrl(msg.url)) {
      return { ok: false, name: 'Error', message: 'Only the configured LLM APIs can be called through this proxy.' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(Number(msg.timeoutMs) || 120000, 180000));
    try {
      const method = msg.method === 'GET' ? 'GET' : 'POST'; // GET only lists models
      const res = await fetch(msg.url, {
        method,
        headers: msg.headers || {},
        body: method === 'POST' ? msg.body : undefined,
        signal: controller.signal,
      });
      return { ok: true, status: res.status, retryAfter: res.headers.get('retry-after'), text: await res.text() };
    } catch (err) {
      return { ok: false, name: err?.name || 'Error', message: String(err?.message || err) };
    } finally {
      clearTimeout(timer);
    }
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== OFFSCREEN_TARGET) return false; // not for us
  if (sender.id !== chrome.runtime.id) return false;  // only our own extension
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler(msg).then(sendResponse, (err) => sendResponse(errorReply(err)));
  return true; // keep the channel open for the async answer
});

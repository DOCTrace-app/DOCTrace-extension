// Persistent storage for recorded sessions, in the "docTraceDB" IndexedDB database.
// Recordings made before the DOCTrace rename (in "scribeDB") are copied over once;
// the old database is left untouched.
//
// Object stores added by this module (only if missing):
//   sc_sessions  key: sessionId              one record per recording
//   sc_steps     key: [sessionId, stepNumber] one record per step, with the
//                                            REDACTED image Blob (never the raw one)
//
// Adding a store needs an IndexedDB version upgrade. We open the database at
// its CURRENT version, and only if our stores are missing we reopen it at
// version + 1. Every connection closes itself on "versionchange", so a later
// Group 1 upgrade is never blocked by us. Group 1 must open scribeDB WITHOUT
// a fixed old version number (or add these two stores in their own db.js).

export const DB_NAME = 'docTraceDB';
const LEGACY_DB_NAME = 'scribeDB';
const MIGRATED_FLAG = 'dtDbMigratedFromScribeDB';
export const SESSIONS = 'sc_sessions';
export const STEPS = 'sc_steps';
export const AUDIO = 'sc_audio'; // voice narration: key [sessionId, part], raw (unscrubbed) audio Blob

let dbPromise = null;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function ensureStores(db) {
  if (!db.objectStoreNames.contains(SESSIONS)) {
    const s = db.createObjectStore(SESSIONS, { keyPath: 'sessionId' });
    s.createIndex('startTime', 'startTime');
  }
  if (!db.objectStoreNames.contains(STEPS)) {
    db.createObjectStore(STEPS, { keyPath: ['sessionId', 'stepNumber'] });
  }
  if (!db.objectStoreNames.contains(AUDIO)) {
    db.createObjectStore(AUDIO, { keyPath: ['sessionId', 'part'] });
  }
}

const hasAllStores = (db) => [SESSIONS, STEPS, AUDIO].every((s) => db.objectStoreNames.contains(s));

function watch(db) {
  db.onversionchange = () => { db.close(); dbPromise = null; };
  return db;
}

function openAt(version) {
  return new Promise((resolve, reject) => {
    const r = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
    r.onupgradeneeded = () => ensureStores(r.result);
    r.onsuccess = () => resolve(watch(r.result));
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error(`${DB_NAME} upgrade is blocked by another open tab. Close other extension pages and try again.`));
  });
}

async function openReady() {
  const db = await openAt();
  if (hasAllStores(db)) return db;
  const next = db.version + 1;
  db.close();
  return openAt(next);
}

/** One-time copy of sessions and steps from the pre-rename database. */
async function migrateLegacy(db) {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage || typeof indexedDB.databases !== 'function') return;
  if ((await storage.get(MIGRATED_FLAG))[MIGRATED_FLAG]) return;
  const exists = (await indexedDB.databases()).some((d) => d.name === LEGACY_DB_NAME);
  if (exists) {
    const legacy = await new Promise((resolve, reject) => {
      const r = indexedDB.open(LEGACY_DB_NAME);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      if (legacy.objectStoreNames.contains(SESSIONS) && legacy.objectStoreNames.contains(STEPS)) {
        const read = legacy.transaction([SESSIONS, STEPS], 'readonly');
        const [sessions, steps] = await Promise.all([
          req(read.objectStore(SESSIONS).getAll()),
          req(read.objectStore(STEPS).getAll()),
        ]);
        const write = db.transaction([SESSIONS, STEPS], 'readwrite');
        // add() never overwrites anything already recorded under the new name.
        for (const s of sessions) write.objectStore(SESSIONS).add(s).onerror = (e) => e.preventDefault();
        for (const s of steps) write.objectStore(STEPS).add(s).onerror = (e) => e.preventDefault();
        await new Promise((resolve, reject) => {
          write.oncomplete = resolve;
          write.onerror = (e) => e.preventDefault();
          write.onabort = () => reject(write.error || new Error('migration aborted'));
        });
      }
    } finally {
      legacy.close();
    }
  }
  await storage.set({ [MIGRATED_FLAG]: true });
}

export function openDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await openReady();
      try { await migrateLegacy(db); } catch (err) { console.warn('DOCTrace: could not copy old recordings', err); }
      return db;
    })().catch((err) => { dbPromise = null; throw err; });
  }
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const db = await openDb();
  const t = db.transaction(stores, mode);
  const result = await fn(t);
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
  return result;
}

const stepRange = (sessionId) => IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);

// ---------- sessions ----------
export function putSession(session) {
  return tx([SESSIONS], 'readwrite', (t) => req(t.objectStore(SESSIONS).put(session)));
}

export function getSession(sessionId) {
  return tx([SESSIONS], 'readonly', (t) => req(t.objectStore(SESSIONS).get(sessionId)));
}

export async function updateSession(sessionId, patch) {
  return tx([SESSIONS], 'readwrite', async (t) => {
    const store = t.objectStore(SESSIONS);
    const cur = await req(store.get(sessionId));
    if (!cur) throw new Error(`Unknown session ${sessionId}`);
    const next = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) };
    await req(store.put(next));
    return next;
  });
}

export async function listSessions() {
  const all = await tx([SESSIONS], 'readonly', (t) => req(t.objectStore(SESSIONS).getAll()));
  return all.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
}

export function deleteSession(sessionId) {
  return tx([SESSIONS, STEPS, AUDIO], 'readwrite', async (t) => {
    await req(t.objectStore(STEPS).delete(stepRange(sessionId)));
    await req(t.objectStore(AUDIO).delete(stepRange(sessionId)));
    await req(t.objectStore(SESSIONS).delete(sessionId));
  });
}

// ---------- voice narration audio ----------
/** { sessionId, part, startedAt (ms epoch), durationMs, mimeType, blob } */
export function putAudio(record) {
  return tx([AUDIO], 'readwrite', (t) => req(t.objectStore(AUDIO).put(record)));
}

export async function getAudio(sessionId) {
  const parts = await tx([AUDIO], 'readonly', (t) => req(t.objectStore(AUDIO).getAll(stepRange(sessionId))));
  return parts.sort((a, b) => a.part - b.part);
}

// ---------- steps ----------
export function putStep(step) {
  return tx([STEPS], 'readwrite', (t) => req(t.objectStore(STEPS).put(step)));
}

export function getStep(sessionId, stepNumber) {
  return tx([STEPS], 'readonly', (t) => req(t.objectStore(STEPS).get([sessionId, stepNumber])));
}

export function hasStep(sessionId, stepNumber) {
  return tx([STEPS], 'readonly', async (t) => (await req(t.objectStore(STEPS).getKey([sessionId, stepNumber]))) !== undefined);
}

/** Steps in order. withImages=false leaves out the Blob (for the LLM and lists). */
export async function getSteps(sessionId, { withImages = true } = {}) {
  const steps = await tx([STEPS], 'readonly', (t) => req(t.objectStore(STEPS).getAll(stepRange(sessionId))));
  steps.sort((a, b) => a.stepNumber - b.stepNumber);
  if (withImages) return steps;
  return steps.map(({ redactedBlob, ...rest }) => rest);
}

export async function updateStep(sessionId, stepNumber, patch) {
  return tx([STEPS], 'readwrite', async (t) => {
    const store = t.objectStore(STEPS);
    const cur = await req(store.get([sessionId, stepNumber]));
    if (!cur) throw new Error(`Unknown step ${sessionId} #${stepNumber}`);
    const next = { ...cur, ...patch };
    await req(store.put(next));
    return next;
  });
}

// ---------- manifest ----------
/** The exportable manifest. Contains no image data and no raw text. */
export async function buildManifest(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Unknown session ${sessionId}`);
  const steps = await getSteps(sessionId, { withImages: false });
  return {
    format: 'doctrace-manual',
    version: 3,
    sessionId: session.sessionId,
    sessionTitle: session.sessionTitle,
    startTime: session.startTime,
    endTime: session.endTime ?? null,
    totalSteps: steps.length,
    failedSteps: steps.filter((s) => s.status !== 'redacted').map((s) => s.stepNumber),
    manualGeneratedBy: session.manualGeneratedBy ?? null,
    intro: session.manualIntro || '',
    guideIntroNarration: session.narrationIntro || '',    // what was said before the first click (scrubbed)
    spokenIntro: session.narrationIntro || '',            // v3.0 name of the same value
    // Voice narration status, so an export shows whether voice was recorded and used.
    voice: {
      recorded: Boolean(session.voice),
      status: session.voiceStatus || 'off',
      error: session.voiceError || null,
      stepsWithNarration: session.voiceSteps ?? 0,
      transcribedBy: session.transcribedBy || null,
    },
    steps: steps.map((s) => ({
      // v3: what was said is bound to the step it was said on, next to the written parts.
      stepNumber: s.stepNumber,
      timestamp: s.timestamp,
      actionType: s.action,
      clickCoords: s.clickCoords,
      targetLabel: s.targetLabel === null ? null : (s.targetLabel || ''),
      redactedImageFileName: s.status === 'redacted' ? s.redactedImageFileName : null,
      spokenNarration: s.narration || '',                 // scrubbed transcript of what was said on this step
      stepTitle: s.manualTitle || '',
      instruction: s.manualDescription || '',
      whereToFindIt: s.manualUiLandmarks || '',
      screenContext: s.manualScreenContext || '',
      expectedOutcome: s.manualExpectedOutcome || '',
      note: s.manualNote || '',
      // v2 names of the same values, kept so older readers keep working
      action: s.action,
      stepDescription: s.manualDescription || '',
      actionInstruction: s.manualDescription || '',
      uiLandmarks: s.manualUiLandmarks || '',
      narration: s.narration || '',
      detectedPii: s.detectedPiiSummary || [],
      descriptionSource: s.descriptionSource || null,
      dwellTimeMs: s.dwellTimeMs ?? null,
      pageTitle: s.pageTitle || '',
      url: s.url || '',
      scrubbedOcrText: s.scrubbedOcrText || '',
      status: s.status,
      // v1 names, kept so older readers of manual_manifest.json keep working
      detectedPiiSummary: s.detectedPiiSummary || [],
      manualTitle: s.manualTitle || '',
      manualDescription: s.manualDescription || '',
    })),
  };
}

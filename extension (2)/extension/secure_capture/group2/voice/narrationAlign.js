// Match transcribed phrases to recorded steps.
//
// Time alone is not enough (Recording 9): people click a field and THEN say
// "now we fill the enrollment number" while typing; they say "this is the
// dashboard" about the screen the NEXT screenshot shows; and they add tips
// about what they just did. So each phrase is placed between the step before
// it (P) and the step after it (N), and decided by, in order:
//   1. "this is / here is ..."  -> the step whose screenshot shows that screen (N)
//   2. words that name a step's button, field or page (e.g. "enrollment")
//   3. tips/notes ("the tip is", "make sure", "only ...") -> the step of the sentence before
//   4. announcing ("we will", "now I'll", "next") -> the coming step (N)
//   5. after a field (input) or a pause (observe): still talking about it (P)
//   6. otherwise the coming step (N)
// Speech before the first step that sounds like an introduction ("hello,
// today we are going to ...") becomes the guide's introduction (key 0).

export const CLICK_SLACK_MS = 1200;
export const NARRATION_VERSION = 3; // bump when matching changes: old guides are re-matched (v3: phrases are stored)
export const INTRO_KEY = 0;

const STOP = new Set(('a an the this that these those is are was were be been am to of in on at for from by with and or but so then now here there '
  + 'we i you it they he she our my your their its me us them will would can could should shall may might must do does did going go goes '
  + 'just also very really okay ok um uh like over up down into out about what which who when where how all any some one two click clicking '
  + 'select selecting enter entering fill filling type typing page screen button field option menu').split(' '));

const stem = (w) => w.slice(0, 5);
const words = (s) => (String(s || '').toLowerCase()
  .replace(/\[redacted:([a-z_]+)\]/g, ' $1 ') // a hidden value still names its kind ("password")
  .match(/[a-z0-9]+/g) || []);
const keyStems = (s) => new Set(words(s).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem));

const DESCRIBES_SCREEN = /^(and\s+)?(this is|here is|here's|this page|you can see|now we are (on|in|at)|we are now (on|in|at))\b/i;
const TIP = /\b(tip|note|remember|make sure|be sure|don't forget|do not forget|important|only|must|required|same for all)\b/i;
const ANNOUNCES = /\b(will|going to|gonna|now (i|we|let'?s)|let'?s|next|then)\b/i;
const INTRO = /\b(hello|hi everyone|welcome|today|in this (video|tutorial|guide)|i will show|i'll show|we are going to|we're going to)\b/i;

function labelScore(phrase, step, { withTitle = true } = {}) {
  const p = keyStems(phrase);
  if (!p.size || !step) return 0;
  let score = 0;
  for (const s of keyStems([step.targetLabel, step.clickedText, withTitle ? step.pageTitle : ''].join(' '))) if (p.has(s)) score += 2;
  return score;
}

/** Split a Whisper segment into sentences / clauses, sharing its time by length. */
export function splitPhrase(p) {
  const parts = String(p.text || '')
    .split(/(?<=[.!?])\s+|,\s+(?=(?:and\s+)?(?:this is|here is|then|now|so now)\b)|\s+(?=and this is\b)/i)
    .map((t) => t.trim()).filter(Boolean);
  if (parts.length <= 1) return [p];
  const total = parts.reduce((n, t) => n + t.length, 0) || 1;
  const span = (p.endMs ?? p.startMs) - p.startMs;
  let t = p.startMs;
  return parts.map((text) => {
    const len = (text.length / total) * span;
    const piece = { startMs: t, endMs: t + len, text };
    t += len;
    return piece;
  });
}

function choose(text, P, N, last) {
  if (!P) return N;
  if (!N) return P;
  if (DESCRIBES_SCREEN.test(text)) return N.action === 'complete' || P.action === 'click' ? N : P;
  const sp = labelScore(text, P);
  const sn = labelScore(text, N);
  if (sp !== sn) return sp > sn ? P : N;
  // A tip is about what was just being talked about: the step of the sentence before it.
  if (TIP.test(text) && !ANNOUNCES.test(text)) return last === P || last === N ? last : P;
  if (ANNOUNCES.test(text)) return N;
  if (P.action === 'input' || P.action === 'observe') return P;
  return N;
}

/**
 * @param phrases [{ startMs, endMs, text }]  absolute wall-clock ms
 * @param steps   [{ stepNumber, timestamp, action?, targetLabel?, clickedText?, pageTitle? }]
 * @returns Map stepNumber -> text (phrases joined in order); key 0 = spoken introduction
 */
export function alignNarration(phrases, steps) {
  const ordered = [...steps].filter((s) => Number.isFinite(s.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
  const out = new Map();
  if (!ordered.length) return out;
  const add = (key, text) => out.set(key, out.has(key) ? `${out.get(key)} ${text}` : text);
  const pieces = [...phrases].sort((a, b) => a.startMs - b.startMs).flatMap(splitPhrase);
  let last = null;
  for (const p of pieces) {
    const text = String(p.text || '').trim();
    if (!text) continue;
    const mid = (p.startMs + (Number.isFinite(p.endMs) ? p.endMs : p.startMs)) / 2;
    const idx = ordered.findIndex((s) => s.timestamp >= mid - CLICK_SLACK_MS);
    const N = idx === -1 ? null : ordered[idx];
    const P = idx === -1 ? ordered[ordered.length - 1] : ordered[idx - 1] || null;
    // Page titles ("... University") are shared by intros, so only the clicked element counts here.
    if (!P && INTRO.test(text) && !labelScore(text, N, { withTitle: false })) { add(INTRO_KEY, text); continue; }
    last = choose(text, P, N, last);
    add(last.stepNumber, text);
  }
  return out;
}

/**
 * Strict time-window matching (DOCTrace spec, Part 1):
 *   S_i = time of step i, E_i = time of step i+1 (last step: end of audio).
 *   A segment whose midpoint falls in [S_i, E_i) belongs to step i.
 *   Segments before S_0 become the guide introduction (key 0).
 * Times are absolute ms here (T0 + relative seconds), which is the same split.
 */
export function alignNarrationTimeWindow(phrases, steps) {
  const ordered = [...steps].filter((s) => Number.isFinite(s.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
  const out = new Map();
  if (!ordered.length) return out;
  const add = (key, text) => out.set(key, out.has(key) ? `${out.get(key)} ${text}` : text);
  for (const p of [...phrases].sort((a, b) => a.startMs - b.startMs)) {
    const text = String(p.text || '').trim();
    if (!text) continue;
    const mid = (p.startMs + (Number.isFinite(p.endMs) ? p.endMs : p.startMs)) / 2;
    if (mid < ordered[0].timestamp) { add(INTRO_KEY, text); continue; }
    let i = ordered.length - 1; // last step runs until the end of the audio
    while (i > 0 && mid < ordered[i].timestamp) i -= 1;
    add(ordered[i].stepNumber, text);
  }
  return out;
}

export const MATCHING_MODES = { smart: alignNarration, timeWindow: alignNarrationTimeWindow };
export const alignByMode = (mode, phrases, steps) => (MATCHING_MODES[mode] || alignNarration)(phrases, steps);

// Whisper sometimes "hears" stock phrases in silence or noise.
const HALLUCINATIONS = /^(thank you\.?|thanks for watching!?|you|bye\.?|\.+|subtitles by .*)$/i;

/** Whisper verbose_json segments (seconds, relative to the file) -> absolute phrases. */
export function phrasesFromWhisper(segments, partStartedAt) {
  return (segments || [])
    .filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .filter((s) => !(Number(s.no_speech_prob) > 0.6))
    .filter((s) => !HALLUCINATIONS.test(s.text.trim()))
    .map((s) => ({
      startMs: partStartedAt + Number(s.start || 0) * 1000,
      endMs: partStartedAt + Number(s.end ?? s.start ?? 0) * 1000,
      text: s.text.trim(),
    }));
}

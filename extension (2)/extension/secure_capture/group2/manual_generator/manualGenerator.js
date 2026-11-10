// Tutorial manual generator.
//
//   stored step (already scrubbed) -> step context (text + metadata only)
//   -> PRIVACY GUARD (re-scrub every value, then prove nothing is left)
//   -> prompt -> text LLM, or Gemini with a separately guarded redacted image
//   -> parse JSON
//   -> scrub the answer too -> save manualTitle / manualDescription
//
// Runs in the SERVICE WORKER (or an extension page). It reads records from
// docTraceDB without images for text providers. Gemini loads only each current
// group's stored redactedBlob after the upload guard passes.
// If the LLM is off, not configured, or fails, a rule-based template writes
// the step instead, so a manual is always produced.

import { CONFIG } from '../config.js';
import { loadClassifier } from '../detection/mlClassifier.js';
import { scrubTextSync } from '../privacy/textScrubber.js';
import * as store from '../storage/sessionStore.js';
import { SYSTEM_PROMPT, VISION_SYSTEM_PROMPT, buildUserPrompt } from './prompts.js';
import { loadSettings, llmReady, isVisionProvider, PROVIDERS, rememberModel, rememberPerRequest } from './settings.js';
import { callGemini, prepareGeminiImages, runGeminiGroups, GeminiRequestError } from './geminiClient.js';
import { callOpenAIVision, getWorkingVisionModel } from './visionClient.js';

export class PrivacyGuardError extends Error {
  constructor(message) { super(message); this.code = 'PRIVACY_GUARD'; }
}

// ---------- 1. context (what the LLM is allowed to see) ----------
function screenArea(p, width, height) {
  if (!p || !width || !height) return '';
  const col = p.x < width / 3 ? 'left' : p.x > (2 * width) / 3 ? 'right' : 'center';
  const row = p.y < height / 3 ? 'top' : p.y > (2 * height) / 3 ? 'bottom' : 'middle';
  return row === 'middle' && col === 'center' ? 'center of the screen' : `${row}-${col} of the screen`;
}

// Host + path only: no query string, no fragment (stored URLs are scrubbed already).
export function urlPathOf(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/+$/, '') || u.host;
  } catch {
    return String(url).split(/[?#]/)[0];
  }
}

/** Only these fields can ever reach a prompt. No image, no raw text, no coordinates beyond a coarse area. */
export function buildStepContext(step) {
  return {
    stepNumber: step.stepNumber,
    actionType: step.action,
    targetLabel: step.targetLabel || '',
    textUnderClick: step.clickedText || '',
    textNearClick: step.nearClickText || '',
    clickArea: screenArea(step.clickCoords, step.width, step.height),
    clickedHiddenField: Boolean(step.clickOnRedactedArea),
    hiddenDataOnScreen: step.detectedPiiSummary || [],
    pageTitle: step.pageTitle || '',
    urlPath: urlPathOf(step.url),
    scrubbedOcrText: (step.scrubbedOcrText || '').slice(0, CONFIG.recorder.maxOcrCharsPerStep),
    narration: step.narration || '', // the user's own words, transcribed and scrubbed
  };
}

// ---------- 2. privacy guard ----------
const IMAGE_DATA = /data:image\/|base64,|[A-Za-z0-9+/]{400,}/;

function scrubValue(value, clf) {
  if (typeof value === 'string') return scrubTextSync(value, clf).text;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, clf));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v, clf)]));
  }
  return value;
}

function findLeaks(value, clf, path = '') {
  if (typeof value === 'string') {
    const leaks = [];
    if (IMAGE_DATA.test(value)) leaks.push(`${path}: image data`);
    const r = scrubTextSync(value, clf);
    if (r.changed) leaks.push(`${path}: ${r.types.join(', ')}`);
    return leaks;
  }
  if (value instanceof Blob) return [`${path}: binary data`];
  if (Array.isArray(value)) return value.flatMap((v, i) => findLeaks(v, clf, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => findLeaks(v, clf, path ? `${path}.${k}` : k));
  return [];
}

/**
 * Defense in depth. Stored values were scrubbed already; we scrub them AGAIN
 * here, then check that a third pass finds nothing. If anything is still
 * found (or any image data is present), the call is refused: fail closed.
 */
export function guardContexts(contexts, clf) {
  const cleaned = scrubValue(contexts, clf);
  const leaks = findLeaks(cleaned, clf);
  if (leaks.length) throw new PrivacyGuardError(`Prompt blocked, sensitive data found: ${leaks.slice(0, 5).join('; ')}`);
  return cleaned;
}

export function buildPrompt({ sessionTitle, previousSteps = [], contexts, spokenIntro = '' }, clf) {
  const safeContexts = guardContexts(contexts, clf);
  const safeTitle = guardContexts({ t: sessionTitle || '' }, clf).t;
  const safePrevious = guardContexts(previousSteps, clf);
  const safeIntro = guardContexts({ t: spokenIntro || '' }, clf).t;
  const user = buildUserPrompt({ sessionTitle: safeTitle, previousSteps: safePrevious, steps: safeContexts, spokenIntro: safeIntro });
  if (IMAGE_DATA.test(user)) throw new PrivacyGuardError('Prompt blocked: image data found');
  return { system: SYSTEM_PROMPT, user };
}

// ---------- 3. API callers ----------
async function postJson(url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
      if (res.ok) return res.json();
      const retry = res.status === 429 || res.status >= 500;
      if (!retry || attempt === 1) throw new Error(`LLM endpoint returned ${res.status}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error('LLM endpoint failed');
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('LLM request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function callLLM(settings, prompt, { images = [] } = {}) {
  const { system, user } = prompt;
  if (settings.provider === 'gemini') {
    return callGemini(settings, { system: VISION_SYSTEM_PROMPT, user }, images);
  }
  if (isVisionProvider(settings)) {
    // Groq, Mistral: OpenAI-style API with redacted screenshots.
    const text = await callOpenAIVision({ ...settings, providerLabel: PROVIDERS[settings.provider].short }, { system: VISION_SYSTEM_PROMPT, user }, images);
    const found = getWorkingVisionModel(settings);
    if (found && found !== settings.model) await rememberModel(settings.provider, found).catch(() => {});
    return text;
  }
  if (settings.provider === 'anthropic') {
    const data = await postJson(settings.endpoint, {
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }, {
      model: settings.model,
      max_tokens: 8192, // five-part steps are several times longer than one-liners
      system,
      messages: [{ role: 'user', content: user }],
    }, settings.timeoutMs);
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  // OpenAI-compatible chat completions (OpenAI, Ollama, LM Studio, vLLM, ...)
  const headers = settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {};
  const data = await postJson(settings.endpoint, headers, {
    model: settings.model,
    temperature: 0.2,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }, settings.timeoutMs);
  return data.choices?.[0]?.message?.content || '';
}

// ---------- 4. parsing ----------
export function parseManualResponse(text, expectedNumbers) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('LLM answer contained no JSON');
  const json = JSON.parse(cleaned.slice(start, end + 1));
  const list = Array.isArray(json) ? json : json.steps;
  if (!Array.isArray(list)) throw new Error('LLM answer has no "steps" list');
  const field = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const byNumber = new Map();
  for (const item of list) {
    const n = Number(item?.stepNumber);
    // Five-part schema (stepTitle/actionInstruction/...); title/instruction still accepted.
    const instruction = field(item?.actionInstruction ?? item?.instruction, 1000);
    if (!expectedNumbers.includes(n) || !instruction) continue;
    byNumber.set(n, {
      title: field(item.stepTitle ?? item.title, 80),
      instruction: instruction.replace(/^step\s*\d+\s*[:.-]\s*/i, '').slice(0, 400),
      screenContext: field(item.screenContext, 500),
      uiLandmarks: field(item.uiLandmarks, 300),
      expectedOutcome: field(item.expectedOutcome, 400),
      note: field(item.note, 400),
    });
  }
  return byNumber;
}

export const RICH_PARTS = ['screenContext', 'uiLandmarks', 'expectedOutcome', 'note'];

/** The guide introduction from an answer ("" when absent). Scrubbed like every answer. */
export function parseIntro(text, clf) {
  try {
    const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
    const json = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
    const intro = typeof json?.intro === 'string' ? json.intro.trim().slice(0, 600) : '';
    return intro ? humanizeTokens(scrubTextSync(intro, clf).text) : '';
  } catch {
    return '';
  }
}

// ---------- 5. template fallback (no LLM needed) ----------
const quoted = (s) => (s ? `'${s}'` : '');
const usable = (s) => s && !/\[REDACTED:/.test(s) ? s.trim() : '';

export function templateDescription(ctx) {
  const label = usable(ctx.targetLabel) || usable(ctx.textUnderClick);
  const where = ctx.clickArea ? ` in the ${ctx.clickArea}` : '';
  const page = usable(ctx.pageTitle);
  if (ctx.actionType === 'observe') {
    return { title: page ? `Review ${page}`.slice(0, 60) : 'Review the page', instruction: page ? `Review the ${quoted(page)} page.` : 'Review the information shown on this page.' };
  }
  if (ctx.actionType === 'complete') {
    return { title: 'Task Complete', instruction: page ? `The task is complete. You are now on the ${quoted(page)} page.` : 'The task is complete.' };
  }
  if (ctx.actionType === 'navigate') {
    const dest = page || ctx.urlPath;
    return { title: 'Open the page', instruction: dest ? `Go to ${dest}.` : 'Open the next page.' };
  }
  if (ctx.actionType === 'input') {
    const hidden = ctx.clickedHiddenField || /\[REDACTED:/.test(ctx.targetLabel || '');
    const field = label ? `the ${quoted(label)} field` : 'the highlighted field';
    return { title: label ? `Fill in ${label}`.slice(0, 40) : 'Fill in the field', instruction: hidden ? `Enter your details in ${field}.` : `Type the required information in ${field}.` };
  }
  return {
    title: label ? `Click ${label}`.slice(0, 40) : 'Click the highlighted item',
    instruction: label ? `Click ${quoted(label)}${where}.` : `Click the highlighted item${where}.`,
  };
}

// ---------- 6. generation ----------
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function saveDescriptions(sessionId, results, source) {
  for (const [n, r] of results) {
    await store.updateStep(sessionId, n, {
      manualTitle: r.title,
      manualDescription: r.instruction,       // = actionInstruction
      manualScreenContext: r.screenContext || '',
      manualUiLandmarks: r.uiLandmarks || '',
      manualExpectedOutcome: r.expectedOutcome || '',
      manualNote: r.note || '',
      descriptionSource: source,
    });
  }
}

function safeErrorMessage(error, settings) {
  if (isVisionProvider(settings)) {
    return error instanceof GeminiRequestError
      ? error.message
      : `${PROVIDERS[settings.provider].short} could not process this group; template descriptions were used.`;
  }
  let message = String(error?.message || error || 'LLM request failed');
  if (settings.apiKey) message = message.split(settings.apiKey).join('[redacted]');
  return message
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi, '[image omitted]')
    .replace(/[A-Za-z0-9+/]{400,}={0,2}/g, '[binary omitted]')
    .slice(0, 300);
}

export function reconcileManualDescriptions(contexts, answer, clf) {
  const results = scrubAnswer(parseManualResponse(answer, contexts.map((c) => c.stepNumber)), clf);
  const missing = contexts.filter((context) => !results.has(context.stepNumber));
  const fallback = new Map(missing.map((context) => [context.stepNumber, templateDescription(context)]));
  return { results, fallback };
}

export function isManualStepEligible(step, force = false) {
  return step.status === 'redacted'
    && step.descriptionSource !== 'user'
    && (force || step.descriptionSource !== 'llm');
}

// Readers should never see raw tokens in a manual.
const TOKEN_WORDS = {
  email: 'your email address', phone: 'your phone number', cnic: 'your CNIC number', password: 'your password',
  api_key: 'your API key', credit_card: 'your card number', iban: 'your IBAN', passport: 'your passport number',
  national_id: 'your ID number', bank_account: 'your bank account details', date_of_birth: 'your date of birth', sensitive_text: 'the required details',
};
export function humanizeTokens(text) {
  return String(text)
    .replace(/'?\[REDACTED:([a-z_]+)\]'?(\s*'?\[REDACTED:\1\]'?)*/g, (_, t) => TOKEN_WORDS[t] || 'the hidden details')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Scrub what the LLM wrote, just in case it echoed something sensitive, then make tokens readable. */
function scrubAnswer(results, clf) {
  const removeImagePayload = (text) => String(text)
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi, '[image omitted]')
    .replace(/[A-Za-z0-9+/]{400,}={0,2}/g, '[hidden content]');
  for (const r of results.values()) {
    for (const key of ['title', 'instruction', ...RICH_PARTS]) {
      if (typeof r[key] === 'string') r[key] = humanizeTokens(scrubTextSync(removeImagePayload(r[key]), clf).text);
    }
  }
  return results;
}

/**
 * Batch mode: describe every step of a finished session.
 * User-authored descriptions are always kept. Without force, existing LLM
 * descriptions are kept too; templates and undescribed steps may be regenerated.
 * @returns {{ ok, provider, llmSteps, templateSteps, error? }}
 */
export async function generateManual(sessionId, { force = false, settings = null } = {}) {
  const cfg = settings || await loadSettings();
  const session = await store.getSession(sessionId);
  if (!session) return { ok: false, error: 'Unknown session' };
  const vision = isVisionProvider(cfg);
  if (vision && session.status !== 'complete') {
    return { ok: false, error: 'Screenshot descriptions are generated after the recording ends.' };
  }
  const clf = await loadClassifier(CONFIG.ml.modelUrl);
  const steps = (await store.getSteps(sessionId, { withImages: false }))
    .filter((step) => isManualStepEligible(step, force));
  await store.updateSession(sessionId, { manualStatus: 'generating', manualError: null, manualProgress: { done: 0, total: steps.length } });

  // Guide introduction from what was said before the first click (voice narration).
  let introPending = Boolean(session.narrationIntro) && session.manualIntroSource !== 'user' && (force || !session.manualIntro);
  let guideIntro = '';
  let llmSteps = 0;
  let templateSteps = 0;
  let lastError = null;
  const written = [];
  const learned = positiveInteger(cfg.learnedPerRequest?.[cfg.provider], 99); // smaller size a provider forced before
  const groupSize = vision
    // older saved settings said 3 or 5; the provider's own per-request image limit always wins
    ? Math.min(learned, PROVIDERS[cfg.provider].maxImages || 5, Math.max(6, Math.min(8, positiveInteger(cfg.geminiStepsPerCall, 6))))
    : positiveInteger(cfg.stepsPerCall, 20);
  const groups = chunk(steps, groupSize);
  const firstStepNumber = steps[0]?.stepNumber;

  // Context for a group = the steps before it. Built from data that exists up
  // front (written text if any, else the action + what was said), so groups can
  // be sent to the AI in PARALLEL instead of waiting for each other.
  const allSteps = await store.getSteps(sessionId, { withImages: false });
  const priorSteps = (group) => allSteps
    .filter((s) => s.stepNumber < group[0].stepNumber && s.status === 'redacted')
    .slice(-3)
    .map((s) => {
      const base = s.manualDescription || templateDescription(buildStepContext(s)).instruction;
      return { stepNumber: s.stepNumber, instruction: s.narration ? `${base} (said: "${s.narration.slice(0, 200)}")` : base };
    });

  const writeGroup = async (group, { results = new Map(), error = null, skipped = false, skippedStepNumbers = [] } = {}) => {
    const contexts = group.map(buildStepContext);
    if (results.size) {
      llmSteps += results.size;
      await saveDescriptions(sessionId, results, 'llm');
      await store.updateSession(sessionId, { manualGeneratedBy: `${cfg.provider}:${cfg.model}` });
    }
    const missing = contexts.filter((context) => !results.has(context.stepNumber));
    const fallback = new Map(missing.map((context) => [context.stepNumber, templateDescription(context)]));
    templateSteps += fallback.size;
    await saveDescriptions(sessionId, fallback, 'template');
    if (error) lastError = safeErrorMessage(error, cfg);
    else if (skipped) lastError = 'The daily request limit was already used up for this recording; templates were used.';
    else if (skippedStepNumbers.length) lastError = 'Some screenshots could not be safely prepared; templates were used for those steps.';
    for (const context of contexts) {
      const description = results.get(context.stepNumber) || fallback.get(context.stepNumber);
      written.push({ stepNumber: context.stepNumber, instruction: description.instruction });
    }
    // Progress for the Guides page ("Writing step descriptions... 6 of 10").
    await store.updateSession(sessionId, { manualProgress: { done: written.length, total: steps.length } });
    globalThis.chrome?.runtime?.sendMessage?.({ type: 'SC_MANUAL_UPDATED', sessionId })?.catch?.(() => {});
  };

  try {
    if (vision) {
      const ready = llmReady(cfg);
      if (!ready) {
        for (const group of groups) await writeGroup(group);
      } else {
        // Steps per request. Shrinks for the rest of the session when a provider says
        // one request is too large (Groq free tier: HTTP 413, tokens per minute).
        let perRequest = groupSize;
        const describe = async (group, { trimText = false } = {}) => {
          if (group.length > perRequest) {
            const merged = { results: new Map(), skippedStepNumbers: [] };
            for (let i = 0; i < group.length; i += perRequest) {
              const part = await describe(group.slice(i, i + perRequest));
              for (const [n, r] of part.results) merged.results.set(n, r);
              merged.skippedStepNumbers.push(...part.skippedStepNumbers);
            }
            return merged;
          }
          let contexts = group.map(buildStepContext);
          if (trimText) contexts = contexts.map((c) => ({ ...c, scrubbedOcrText: c.scrubbedOcrText.slice(0, 600) }));
          const previousSteps = priorSteps(group);
          buildPrompt({ sessionTitle: session.sessionTitle, previousSteps, contexts }, clf);

          const { images, skippedStepNumbers } = await prepareGeminiImages(group, store.getStep);
          const imageNumbers = new Set(images.map((image) => image.stepNumber));
          const safeContexts = contexts.filter((context) => imageNumbers.has(context.stepNumber));
          if (!images.length) return { results: new Map(), skippedStepNumbers };

          const withIntro = introPending && group.some((s) => s.stepNumber === firstStepNumber);
          const prompt = buildPrompt({
            sessionTitle: session.sessionTitle,
            previousSteps,
            contexts: safeContexts,
            spokenIntro: withIntro ? session.narrationIntro : '',
          }, clf);
          try {
            const answer = await callLLM(cfg, prompt, { images });
            const { results } = reconcileManualDescriptions(safeContexts, answer, clf);
            if (withIntro) { guideIntro = parseIntro(answer, clf); introPending = !guideIntro; }
            return { results, skippedStepNumbers };
          } catch (err) {
            if (err?.code !== 'REQUEST_TOO_LARGE') throw err;
            if (group.length > 1) {
              perRequest = Math.max(1, Math.min(perRequest, Math.floor(group.length / 2)));
              rememberPerRequest(cfg.provider, perRequest).catch(() => {}); // next guide starts this small
              return describe(group);
            }
            if (!trimText) return describe(group, { trimText: true }); // one screenshot, less screen text
            throw err;
          }
        };
        const { dailyQuotaExhausted } = await runGeminiGroups(
          groups,
          (group) => describe(group),
          writeGroup,
          {
            initiallyExhausted: Boolean(session.geminiQuotaExhausted),
            onDailyQuota: () => store.updateSession(sessionId, { geminiQuotaExhausted: true }),
            concurrency: Math.min(4, positiveInteger(cfg.llmConcurrency, 2)), // requests in flight at once
          },
        );
        if (dailyQuotaExhausted && !lastError) {
          lastError = 'The daily request limit is used up; remaining descriptions use templates.';
        }
      }
    } else {
      for (const group of groups) {
        const contexts = group.map(buildStepContext);
        let results = new Map();
        if (llmReady(cfg)) {
          try {
            const withIntro = introPending && written.length === 0;
            const prompt = buildPrompt({
              sessionTitle: session.sessionTitle, previousSteps: written.slice(-3), contexts,
              spokenIntro: withIntro ? session.narrationIntro : '',
            }, clf);
            const answer = await callLLM(cfg, prompt);
            ({ results } = reconcileManualDescriptions(contexts, answer, clf));
            if (withIntro) { guideIntro = parseIntro(answer, clf); introPending = !guideIntro; }
          } catch (error) {
            lastError = safeErrorMessage(error, cfg);
          }
        }
        await writeGroup(group, { results });
      }
    }

    const finalSteps = await store.getSteps(sessionId, { withImages: false });
    const savedLlmSteps = finalSteps.filter((step) => step.descriptionSource === 'llm').length;
    const savedTemplateSteps = finalSteps.filter((step) => step.descriptionSource === 'template').length;
    const provider = llmSteps ? `${cfg.provider}:${cfg.model}` : (savedLlmSteps ? session.manualGeneratedBy : 'template');
    await store.updateSession(sessionId, {
      ...(guideIntro ? { manualIntro: guideIntro } : {}),
      manualStatus: savedLlmSteps ? 'done' : 'template',
      manualGeneratedBy: provider || 'template',
      manualError: lastError,
      manualLlmSteps: savedLlmSteps,
      manualTemplateSteps: savedTemplateSteps,
    });
    return { ok: true, provider, llmSteps, templateSteps, error: lastError || undefined };
  } catch (error) {
    const message = safeErrorMessage(error, cfg);
    await store.updateSession(sessionId, { manualStatus: 'error', manualError: message });
    return { ok: false, error: message };
  }
}

/**
 * Real-time mode: describe one step as soon as it is stored.
 * Gemini gets this step's guarded REDACTED screenshot; text providers get text only.
 * A step that falls back to a template here is retried by the end-of-session batch.
 */
export async function generateStepDescription(sessionId, stepNumber, { settings = null } = {}) {
  const cfg = settings || await loadSettings();
  const clf = await loadClassifier(CONFIG.ml.modelUrl);
  const session = await store.getSession(sessionId);
  const step = await store.getStep(sessionId, stepNumber);
  if (!session || !step || step.status !== 'redacted' || step.descriptionSource === 'user') return { ok: false, skipped: true };
  const ctx = buildStepContext({ ...step, redactedBlob: undefined });
  const previous = (await store.getSteps(sessionId, { withImages: false }))
    .filter((s) => s.stepNumber < stepNumber && s.manualDescription)
    .slice(-3)
    .map((s) => ({ stepNumber: s.stepNumber, instruction: s.manualDescription }));
  const gemini = isVisionProvider(cfg); // any screenshot-reading provider

  if (llmReady(cfg) && !(gemini && session.geminiQuotaExhausted)) {
    try {
      const prompt = buildPrompt({ sessionTitle: session.sessionTitle, previousSteps: previous, contexts: [ctx] }, clf);
      let images = [];
      if (gemini) {
        // Only the stored redactedBlob, and only after the upload guard passes.
        ({ images } = await prepareGeminiImages([{ sessionId, stepNumber }], store.getStep));
        if (!images.length) throw new GeminiRequestError('NO_PROTECTED_IMAGES', 'This screenshot could not be safely prepared; a template was used.');
      }
      const { results } = reconcileManualDescriptions([ctx], await callLLM(cfg, prompt, { images }), clf);
      if (results.has(stepNumber)) {
        await saveDescriptions(sessionId, results, 'llm');
        await store.updateSession(sessionId, { manualGeneratedBy: `${cfg.provider}:${cfg.model}` });
        return { ok: true, source: 'llm' };
      }
    } catch (err) {
      if (err instanceof GeminiRequestError && err.dailyQuotaExhausted) {
        await store.updateSession(sessionId, { geminiQuotaExhausted: true });
      }
      await saveDescriptions(sessionId, new Map([[stepNumber, templateDescription(ctx)]]), 'template');
      return { ok: true, source: 'template', error: safeErrorMessage(err, cfg) };
    }
  }
  await saveDescriptions(sessionId, new Map([[stepNumber, templateDescription(ctx)]]), 'template');
  return { ok: true, source: 'template' };
}

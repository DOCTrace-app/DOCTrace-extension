// Options page for the manual generator.
import { loadSettings, saveSettings, PROVIDERS, llmReady, isVisionProvider } from '../group2/manual_generator/settings.js';
import { buildPrompt, callLLM, parseManualResponse } from '../group2/manual_generator/manualGenerator.js';
import { prepareGeminiImages } from '../group2/manual_generator/geminiClient.js';
import { loadClassifier } from '../group2/detection/mlClassifier.js';
import { CONFIG } from '../group2/config.js';
import { processFrame } from '../group2/pipeline.js';
import { loadVoiceSettings, saveVoiceSettings } from '../group2/voice/voiceSettings.js';

const $ = (id) => document.getElementById(id);
const status = (t) => { $('status').textContent = t; };

// Each provider keeps its own key; switching provider never carries a key over.
let keys = {};
let consentFor = null;
let currentProvider = null;

function read() {
  return {
    enabled: $('enabled').checked,
    consent: $('consent').checked,
    imageConsent: $('imageConsent').checked,
    provider: $('provider').value,
    endpoint: $('endpoint').value.trim(),
    model: $('model').value.trim(),
    apiKey: $('apiKey').value.trim(),
    apiKeys: { ...keys, [$('provider').value]: $('apiKey').value.trim() },
    mode: document.querySelector('input[name=mode]:checked')?.value || 'batch',
  };
}

function fill(s) {
  keys = { ...(s.apiKeys || {}) };
  consentFor = s.consentFor;
  currentProvider = s.provider;
  $('enabled').checked = s.enabled;
  $('consent').checked = s.consent;
  $('imageConsent').checked = s.imageConsent;
  $('provider').value = s.provider;
  $('endpoint').value = s.endpoint;
  $('model').value = s.model;
  $('apiKey').value = s.apiKey;
  const r = document.querySelector(`input[name=mode][value=${s.mode}]`);
  if (r) r.checked = true;
  $('llmFields').classList.toggle('off', !s.enabled);
  renderProvider(s);
}

function renderProvider(settings = read()) {
  const p = PROVIDERS[settings.provider];
  const vision = isVisionProvider(settings);
  $('textPrivacy').hidden = vision;
  $('geminiPrivacy').hidden = !vision;
  $('geminiFreeTierWarning').hidden = !vision;
  $('imageConsentRow').hidden = !vision;
  $('geminiBatchNote').hidden = !vision || settings.mode !== 'realtime';
  $('geminiPrivacy').innerHTML = `<b>${p.short}:</b> scrubbed step text and redacted screenshots leave this device and go to ${p.short}. Raw screenshots are never sent. Redaction relies on OCR and can miss photos, unreadable text, or other information.`;
  $('geminiFreeTierWarning').textContent = `On free tiers, ${p.short} may keep or use submitted content under its terms. Review the provider's current terms before enabling this option.`;
  $('imageConsentText').textContent = `I separately understand and allow redacted screenshots to leave this device and be sent to ${p.short} with step text.`;
  $('endpointLabel').textContent = settings.provider === 'gemini' ? 'API base URL' : 'Endpoint URL';
  $('apiKey').placeholder = p.keyHint || '';
  $('privacySummary').textContent = vision
    ? `Off by default. ${p.short} receives scrubbed text and redacted screenshots only with separate consent.`
    : 'Off by default. The selected provider receives scrubbed text only; screenshots are not sent.';
}

function readinessMessage(settings) {
  if (!settings.consent) return 'Tick text consent before testing.';
  if (isVisionProvider(settings) && !settings.imageConsent) return 'Tick the separate screenshot consent before testing.';
  if (!settings.endpoint || !settings.model || (PROVIDERS[settings.provider]?.needsKey && !settings.apiKey)) {
    return 'Fill in the model, endpoint, and API key before testing.';
  }
  return 'Fill in the fields and consent boxes, then test.';
}

// Ask Chrome for permission to reach ONLY this endpoint's origin.
async function requestHost(endpoint) {
  const origin = new URL(endpoint).origin + '/*';
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

$('enabled').addEventListener('change', () => $('llmFields').classList.toggle('off', !$('enabled').checked));
$('provider').addEventListener('change', () => {
  if (currentProvider) keys[currentProvider] = $('apiKey').value.trim();
  currentProvider = $('provider').value;
  const p = PROVIDERS[currentProvider];
  $('endpoint').value = p.endpoint;
  $('model').value = p.model;
  $('apiKey').value = keys[currentProvider] || '';
  // Consent is given per provider: ask again for a different one.
  if (consentFor !== currentProvider) { $('consent').checked = false; $('imageConsent').checked = false; }
  renderProvider();
});
document.querySelectorAll('input[name=mode]').forEach((input) => input.addEventListener('change', () => renderProvider()));

$('btnSave').addEventListener('click', async () => {
  const s = read();
  try {
    if (s.enabled) {
      new URL(s.endpoint);
      if (!(await requestHost(s.endpoint))) return status('Chrome permission for this endpoint was not granted.');
    }
    const saved = await saveSettings(s);
    keys = { ...saved.apiKeys };
    consentFor = saved.consentFor;
    if (saved.enabled && !llmReady(saved)) {
      status(isVisionProvider(saved) && !saved.imageConsent
        ? `Saved. ${PROVIDERS[saved.provider].short} stays off until the separate screenshot consent is checked.`
        : 'Saved. The LLM stays off until consent is checked and the fields are complete.');
    } else {
      status('Saved.');
    }
  } catch (err) {
    status(`Not saved: ${err.message}`);
  }
});

$('btnTest').addEventListener('click', async () => {
  const s = { ...(await loadSettings()), ...read() };
  if (!llmReady(s)) return status(readinessMessage(s));
  status('Testing... this can take up to a minute.');
  const started = performance.now();
  try {
    if (!(await requestHost(s.endpoint))) return status('Chrome permission for this endpoint was not granted.');
    const clf = await loadClassifier(CONFIG.ml.modelUrl);
    const context = { stepNumber: 1, actionType: 'click', targetLabel: 'Settings', textUnderClick: 'Settings', textNearClick: 'Home Reports Settings Help', clickArea: 'top-left of the screen', clickedHiddenField: false, hiddenDataOnScreen: [], pageTitle: 'Dashboard', urlPath: 'example.com/app', scrubbedOcrText: 'Home Reports Settings Help' };
    const prompt = buildPrompt({ sessionTitle: 'Connection test', contexts: [context] }, clf);
    let images = [];
    if (isVisionProvider(s)) {
      const response = await fetch(chrome.runtime.getURL('testdata/01_normal_ui.png'));
      if (!response.ok) throw new Error('Synthetic test image could not be loaded.');
      const imageBlob = await response.blob();
      const bitmap = await createImageBitmap(imageBlob);
      let frame;
      try {
        frame = await processFrame({
          frameId: 'connection-test',
          sessionId: 'connection-test',
          tMs: 0,
          eventId: 'connection-test',
          width: bitmap.width,
          height: bitmap.height,
          dpr: 1,
          imageBlob,
          status: 'raw',
        });
      } finally {
        bitmap.close();
      }
      if (frame.status !== 'redacted') throw new Error('The local test image could not be redacted. It was not sent.');
      ({ images } = await prepareGeminiImages(
        [{ sessionId: 'connection-test', stepNumber: 1 }],
        async () => frame,
      ));
      if (!images.length) throw new Error('The redacted test image could not be prepared. It was not sent.');
    }
    const out = parseManualResponse(await callLLM(s, prompt, { images }), [1]);
    const secs = Math.round((performance.now() - started) / 1000);
    // callLLM saves a discovered model; show it in the field too.
    const fresh = await loadSettings();
    let note = '';
    if (fresh.provider === s.provider && fresh.model !== s.model) {
      $('model').value = fresh.model;
      note = ` (the old model is retired; now using ${fresh.model}, saved)`;
    }
    status(out.has(1) ? `Works (${secs} s)${note}: "${out.get(1).instruction}"` : `Connected (${secs} s)${note}, but the answer was not in the expected format.`);
  } catch (err) {
    const detail = String(err?.message || err).split(s.apiKey || '\u0000').join('[key]').replace(/AIza[0-9A-Za-z_-]{20,}|(gsk|sk)_[A-Za-z0-9]{16,}/g, '[key]');
    status(`Test failed: ${detail}`);
  }
});

loadSettings().then(fill);

// ---------- voice narration (saved as soon as a box changes) ----------
function voiceNote(v) {
  $('voiceStatus').textContent = v.enabled && !v.consent
    ? 'Tick the consent box to start recording your voice.'
    : v.enabled && v.consent ? 'Voice narration is on. Your next recording includes your voice.' : 'Voice narration is off.';
}
loadVoiceSettings().then((v) => {
  $('voiceEnabled').checked = v.enabled;
  $('voiceConsent').checked = v.consent;
  $('voiceMatching').value = v.matching || 'smart';
  voiceNote(v);
});
$('voiceMatching').addEventListener('change', () => saveVoiceSettings({ matching: $('voiceMatching').value }));
for (const id of ['voiceEnabled', 'voiceConsent']) {
  $(id).addEventListener('change', async () => {
    const v = await saveVoiceSettings({ enabled: $('voiceEnabled').checked, consent: $('voiceConsent').checked });
    voiceNote(v);
  });
}

// ---------- microphone picker + test ----------
// Chrome can silently record nothing from a disconnected Bluetooth headset or a
// muted device. Picking the mic here and watching the level bar proves it works.
async function listMics(selectedId) {
  let inputs = [];
  try { inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch { /* no devices */ }
  const sel = $('micDevice');
  sel.innerHTML = '<option value="">System default</option>';
  inputs.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Microphone ${i + 1} (run the test to see names)`;
    sel.appendChild(o);
  });
  sel.value = [...sel.options].some((o) => o.value === selectedId) ? selectedId : '';
}

loadVoiceSettings().then((v) => listMics(v.deviceId));
navigator.mediaDevices?.addEventListener?.('devicechange', async () => listMics((await loadVoiceSettings()).deviceId));
$('micDevice').addEventListener('change', async () => {
  const sel = $('micDevice');
  await saveVoiceSettings({ deviceId: sel.value, deviceLabel: sel.value ? sel.selectedOptions[0].textContent : '' });
  $('micTestText').className = 'small muted';
  $('micTestText').textContent = 'Saved. Run the test to check this microphone.';
});

let testing = false;
$('btnMicTest').addEventListener('click', async () => {
  if (testing) return;
  testing = true;
  const text = $('micTestText');
  const deviceId = $('micDevice').value;
  let stream = null;
  let ctx = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
    });
    await listMics(deviceId); // names appear once permission is granted
    const label = stream.getAudioTracks()[0]?.label || 'microphone';
    ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    text.className = 'small muted';
    text.textContent = `Listening to "${label}" for 5 seconds... say a few words.`;
    let peak = 0;
    const end = performance.now() + 5000;
    await new Promise((resolve) => {
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const x of buf) sum += x * x;
        const rms = Math.sqrt(sum / buf.length);
        peak = Math.max(peak, rms);
        $('micLevel').style.width = `${Math.min(100, Math.round(rms * 400))}%`;
        if (performance.now() < end) requestAnimationFrame(tick); else resolve();
      };
      tick();
    });
    if (peak >= 0.03) {
      text.className = 'small ok';
      text.textContent = `We hear you clearly on "${label}". This microphone will be used for recordings.`;
    } else if (peak >= 0.01) {
      text.className = 'small bad';
      text.textContent = `"${label}" is very quiet. Move closer, raise its volume in Windows sound settings, or pick another microphone.`;
    } else {
      text.className = 'small bad';
      text.textContent = `No sound from "${label}". It may be disconnected, muted, or the wrong device: pick another microphone above and test again.`;
    }
  } catch (err) {
    text.className = 'small bad';
    text.textContent = err?.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Click the icon in the address bar to allow it, then test again.'
      : `Could not open the microphone (${err?.name || 'error'}). Pick another microphone and test again.`;
  } finally {
    for (const t of stream?.getTracks() || []) t.stop();
    ctx?.close().catch(() => {});
    $('micLevel').style.width = '0';
    testing = false;
  }
});

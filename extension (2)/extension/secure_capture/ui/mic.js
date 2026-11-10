// One-time microphone permission. The offscreen document records the voice,
// but it cannot show Chrome's permission prompt; a normal extension tab can.
// Granting it here grants it for the whole extension.

const $ = (id) => document.getElementById(id);

async function ask() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop(); // only asking; nothing is recorded here
    $('text').innerHTML = '<span class="ok">Microphone allowed.</span> Close this tab and press <b>Start recording</b> in DOCTrace again.';
    $('btnAllow').hidden = true;
  } catch (err) {
    $('text').innerHTML = `<span class="err">Microphone was not allowed (${err?.name || 'error'}).</span> Click the icon in the address bar to allow it, or turn off "Record my voice" in the DOCTrace popup.`;
  }
}

$('btnAllow').addEventListener('click', ask);
ask();

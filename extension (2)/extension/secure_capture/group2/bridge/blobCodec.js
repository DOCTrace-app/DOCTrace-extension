// Chrome extension messaging (chrome.runtime.sendMessage) only carries
// JSON-like data, not Blobs. These helpers turn a Blob into base64 and back.
// This is in-memory messaging INSIDE the extension, not a network request.

const CHUNK = 0x8000;

export async function blobToWire(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return { __blob: true, type: blob.type || 'application/octet-stream', base64: btoa(binary) };
}

export function wireToBlob(wire) {
  const binary = atob(wire.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: wire.type });
}

export const isWireBlob = (v) => Boolean(v && v.__blob === true && typeof v.base64 === 'string');

// "data:image/png;base64,...." (from captureVisibleTab) -> Blob
export function dataUrlToBlob(dataUrl) {
  const [head, base64] = String(dataUrl).split(',');
  const type = /data:([^;]+)/.exec(head)?.[1] || 'image/png';
  return wireToBlob({ __blob: true, type, base64: base64 || '' });
}

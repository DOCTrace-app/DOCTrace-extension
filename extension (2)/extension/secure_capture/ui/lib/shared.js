// Small helpers shared by the popup, the result page and the service worker.

export const STORAGE_KEY = 'lastCapture';

export const TYPE_LABELS = {
  email: 'Email',
  phone: 'Phone',
  cnic: 'CNIC',
  password: 'Password',
  api_key: 'API key / token',
  credit_card: 'Card number',
  iban: 'IBAN',
  passport: 'Passport',
  national_id: 'National ID / SSN',
  bank_account: 'Bank account',
  date_of_birth: 'Date of birth',
  sensitive_text: 'Other sensitive text',
};

export function labelFor(type) {
  return TYPE_LABELS[type] || type;
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// { email: 2, phone: 1 } from piiRegions. Overlapping boxes of the same type
// (for example the label box and the field box of one password) count as ONE item.
export function countByType(regions) {
  const groups = []; // { type, boxes: [] }
  for (const r of regions || []) {
    const g = groups.find((x) => x.type === r.type && x.boxes.some((b) => overlaps(b, r.box)));
    if (g) g.boxes.push(r.box);
    else groups.push({ type: r.type, boxes: [r.box] });
  }
  const counts = {};
  for (const g of groups) counts[g.type] = (counts[g.type] || 0) + 1;
  return counts;
}

export const totalCount = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

export function dataUrlToBlob(dataUrl) {
  const [head, base64] = dataUrl.split(',');
  const type = /data:([^;]+)/.exec(head)?.[1] || 'image/png';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

export async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const h = Math.round(m / 60);
  return h === 1 ? '1 hour ago' : `${h} hours ago`;
}

export function fileName(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `doctrace-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function copyImage(blob) {
  const png = blob.type === 'image/png' ? blob : await toPng(blob);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

async function toPng(blob) {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return c.convertToBlob({ type: 'image/png' });
}

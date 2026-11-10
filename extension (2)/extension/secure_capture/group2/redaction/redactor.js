// Local redaction with the browser Canvas API (OffscreenCanvas).
// The ORIGINAL imageBlob is never touched: we draw a copy of the decoded
// image on a new canvas, paint solid rectangles on the copy, and export
// the copy as a NEW Blob.
//
// Why not OpenCV.js? It is ~8 MB and adds nothing here: filling rectangles
// is one canvas call. Solid fill is used instead of blur because blur can
// sometimes be reversed.

import { CONFIG } from '../config.js';

/**
 * @param {ImageBitmap} bitmap  decoded original screenshot
 * @param {{box:{x,y,w,h}}[]} regions  boxes in screenshot pixels (already padded)
 * @param {object} cfg  CONFIG.redaction
 * @param {object} [extras]  { clickPoint: {x, y} in image pixels, dpr }
 *   When given, the click marker is drawn again ON TOP of the masks so the
 *   recorder's highlight stays visible. It is NOT drawn when the click falls
 *   inside a redacted region (the marker must not point at hidden data).
 * @returns {Promise<Blob>} redactedBlob
 */
export async function redactBitmap(bitmap, regions, cfg = CONFIG.redaction, extras = {}) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  ctx.fillStyle = cfg.color;
  for (const { box } of regions) {
    ctx.fillRect(box.x, box.y, box.w, box.h);
  }
  const p = extras.clickPoint;
  if (p && cfg.clickMarker?.enabled && !clickInsideRegion(p, regions)) {
    drawClickMarker(ctx, p, extras.dpr || 1, cfg.clickMarker);
  }
  return canvas.convertToBlob({ type: cfg.outputType });
}

export function clickInsideRegion(p, regions) {
  return regions.some(({ box }) => p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h);
}

function drawClickMarker(ctx, p, dpr, m) {
  const r = m.radius * dpr;
  ctx.save();
  ctx.lineWidth = m.lineWidth * dpr;
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.fill;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(p.x, p.y, Math.max(2, 3 * dpr), 0, Math.PI * 2);
  ctx.fillStyle = m.color;
  ctx.fill();
  ctx.restore();
}

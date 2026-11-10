// Small helpers for boxes in the form { x, y, w, h } (screenshot pixels).

export function right(b) { return b.x + b.w; }
export function bottom(b) { return b.y + b.h; }
export function centerY(b) { return b.y + b.h / 2; }
export function centerX(b) { return b.x + b.w / 2; }
export function area(b) { return Math.max(0, b.w) * Math.max(0, b.h); }

export function union(boxes) {
  const x1 = Math.min(...boxes.map((b) => b.x));
  const y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map(right));
  const y2 = Math.max(...boxes.map(bottom));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function intersection(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(right(a), right(b));
  const y2 = Math.min(bottom(a), bottom(b));
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// Share of box a that lies inside box b (0..1).
export function coveredBy(a, b) {
  const i = intersection(a, b);
  return i ? area(i) / Math.max(1, area(a)) : 0;
}

export function containsPoint(b, x, y) {
  return x >= b.x && x <= right(b) && y >= b.y && y <= bottom(b);
}

export function pad(b, px, py = px) {
  return { x: b.x - px, y: b.y - py, w: b.w + 2 * px, h: b.h + 2 * py };
}

export function clamp(b, width, height) {
  const x1 = Math.max(0, Math.floor(b.x));
  const y1 = Math.max(0, Math.floor(b.y));
  const x2 = Math.min(width, Math.ceil(right(b)));
  const y2 = Math.min(height, Math.ceil(bottom(b)));
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

export function roundBox(b) {
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) };
}

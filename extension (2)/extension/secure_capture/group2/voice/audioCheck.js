// Is a MediaRecorder WebM/Opus recording pure silence?
//
// Opus packets change size constantly with real sound (speech, breathing, room
// noise). Chrome recording a dead or muted device produces packets that are all
// the same size (Recording 7: every packet exactly 168 bytes for 64 s). This
// check reads only packet sizes from the container, so it works even when the
// live level monitor could not run, and needs no audio decoding.

function readVint(buf, i, keepMarker) {
  const first = buf[i];
  if (first === undefined) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) { mask >>= 1; len += 1; }
  if (len > 8) return null;
  let val = keepMarker ? first : first & (mask - 1);
  for (let k = 1; k < len; k++) val = val * 256 + buf[i + k];
  return { val, len };
}

const CONTAINERS = new Set([0x18538067 /* Segment */, 0x1F43B675 /* Cluster */, 0xA0 /* BlockGroup */]);
const BLOCKS = new Set([0xA3 /* SimpleBlock */, 0xA1 /* Block */]);

/** Sizes of all audio blocks in a WebM byte array. */
export function webmBlockSizes(bytes) {
  const sizes = [];
  const walk = (start, end) => {
    let i = start;
    while (i < end && i < bytes.length) {
      const id = readVint(bytes, i, true);
      if (!id) return;
      const size = readVint(bytes, i + id.len, false);
      if (!size) return;
      const body = i + id.len + size.len;
      const unknown = size.val === 2 ** (7 * size.len) - 1;
      const stop = unknown ? bytes.length : Math.min(body + size.val, bytes.length);
      if (CONTAINERS.has(id.val)) walk(body, stop);
      else if (BLOCKS.has(id.val)) sizes.push(size.val);
      i = stop;
    }
  };
  walk(0, bytes.length);
  return sizes;
}

/**
 * @returns {{ silent: boolean|null, blocks, distinctSizes }}
 *   silent null = not enough data to tell (or not WebM)
 */
export function analyzeOpusWebm(bytes) {
  const sizes = webmBlockSizes(bytes);
  if (sizes.length < 40) return { silent: null, blocks: sizes.length, distinctSizes: new Set(sizes).size };
  const counts = new Map();
  for (const s of sizes) counts.set(s, (counts.get(s) || 0) + 1);
  const dominantShare = Math.max(...counts.values()) / sizes.length;
  // Real audio (variable bitrate): sizes spread out, no size is more than a small share.
  // Dead input: one size for almost every packet (Recording 7: 1058 of 1068 were 168 bytes;
  // the few others are the start/end of the file).
  const silent = dominantShare >= 0.9;
  return { silent, blocks: sizes.length, distinctSizes: counts.size, dominantShare: Math.round(dominantShare * 1000) / 1000 };
}

// Contract tests for processFrame() that do not need a browser:
// bad input must give status "failed", never throw, never touch imageBlob.
//   node group2/tests/node/pipelineContract.test.mjs
import { processFrame } from '../../pipeline.js';
import { isUploadable, getUploadPayload } from '../../privacy/guard.js';

let failed = 0;
const check = (name, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${d}`); if (!ok) failed++; };

const imageBlob = new Blob([new TextEncoder().encode('this is not a real PNG image')], { type: 'image/png' });
const frame = { frameId: 'f1', sessionId: 's1', tMs: 42, eventId: 'e1', width: 10, height: 10, dpr: 1, imageBlob, status: 'raw' };
const out = await processFrame(frame);
check('corrupt image -> status failed', out.status === 'failed', out.error);
check('identity fields unchanged', ['frameId', 'sessionId', 'tMs', 'eventId', 'imageBlob'].every((k) => out[k] === frame[k]));
check('input frame not mutated', frame.status === 'raw' && !('error' in frame));
check('failed frame not uploadable', !isUploadable(out) && !('redactedBlob' in out));
let threw = false; try { getUploadPayload(out); } catch { threw = true; }
check('getUploadPayload refuses failed frame', threw);
check('missing imageBlob -> failed', (await processFrame({ frameId: 'x' })).status === 'failed');
check('null frame -> failed, no throw', (await processFrame(null)).status === 'failed');
check('empty blob -> failed', (await processFrame({ ...frame, imageBlob: new Blob([]) })).status === 'failed');

const fake = { ...frame, status: 'redacted', redactedBlob: new Blob(['x']), piiRegions: [], ocrText: [] };
const payload = getUploadPayload(fake);
check('upload payload has no raw imageBlob', !('imageBlob' in payload) && payload.redactedBlob === fake.redactedBlob);

console.log(failed ? `${failed} FAILED` : 'All contract tests passed');
process.exit(failed ? 1 : 0);

// Tiny local web server (no dependencies) to open the demo and test pages
// WITHOUT loading the extension. It sends the same CSP rules as MV3
// extension pages, plus connect-src 'self', so any attempt to call an
// outside server would be blocked and shown in the console.
//
//   node group2/tests/node/serveWithCsp.mjs
//   open http://localhost:8765/group2/demo/demo.html
//   open http://localhost:8765/group2/tests/test.html
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PORT = Number(process.env.PORT || 8765);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.gz': 'application/gzip' };
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self'; "
  + "img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'";

http.createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(path.normalize(ROOT))) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': CSP });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Serving ${ROOT}`);
  console.log(`Demo:  http://localhost:${PORT}/group2/demo/demo.html`);
  console.log(`Tests: http://localhost:${PORT}/group2/tests/test.html`);
});

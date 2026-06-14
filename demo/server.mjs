// Demo harness server. Serves the REAL build output (.output/chrome-mv3) at /,
// injecting /__mock__.js into editor.html + popup.html so the bundles run
// in a plain browser tab (the mock fakes the extension APIs). The shell page
// at / wires the pieces together with a fake "Claude composer" pane.
//
//   npm run build && node demo/server.mjs   ->  http://localhost:4173

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../.output/chrome-mv3', import.meta.url));
const DEMO = fileURLToPath(new URL('.', import.meta.url));
const PORT = 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (p === '/') p = '/index.html';
    let body;
    let type = MIME[extname(p)] ?? 'application/octet-stream';

    if (p === '/index.html') {
      body = await readFile(join(DEMO, 'index.html'));
    } else if (p === '/__mock__.js') {
      body = await readFile(join(DEMO, 'mock.js'));
    } else if (p === '/editor.html' || p === '/popup.html') {
      const html = await readFile(join(ROOT, p.slice(1)), 'utf8');
      body = html.replace('<head>', '<head>\n    <script src="/__mock__.js"></script>');
    } else {
      const safe = normalize(p).replace(/^([\\/.])+/, '');
      body = await readFile(join(ROOT, safe));
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`not found: ${req.url}`);
  }
}).listen(PORT, () => console.log(`shotcache demo at http://localhost:${PORT}`));

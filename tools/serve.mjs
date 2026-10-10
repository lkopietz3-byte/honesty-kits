// Serves dist/ for local checking. No dependencies, and it listens on 127.0.0.1
// only, so nothing else on your network can reach it.
//
//   node tools/build.mjs && node tools/serve.mjs [port]      (default port 8080)
//
// The page is also served under /honesty-kits/, the path it has on GitHub Pages,
// so absolute links behave the same here as on the live site.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const port = process.argv[2] === undefined ? 8080 : Number(process.argv[2]);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`usage: node tools/serve.mjs [port]   (got "${process.argv[2]}")`);
  process.exit(2);
}
if (!existsSync(path.join(root, 'index.html'))) {
  console.error('dist/index.html is missing. Run "npm ci" and "node tools/build.mjs" first.');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
  res.end(body);
}

/** The file a request path names inside dist/, or a status code for why not. */
function resolveRequest(rawPath) {
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return 400; }
  if (decoded.includes('\0') || decoded.includes('\\')) return 400;
  if (decoded === '/honesty-kits') decoded = '/honesty-kits/';
  if (decoded.startsWith('/honesty-kits/')) decoded = decoded.slice('/honesty-kits'.length);
  if (decoded.endsWith('/')) decoded += 'index.html';
  const file = path.resolve(root, `.${decoded}`);
  // Anything that resolves outside dist/ (for example /../package.json) is refused.
  if (file !== path.resolve(root) && !file.startsWith(path.resolve(root) + path.sep)) return 403;
  return file;
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  const file = resolveRequest(new URL(req.url, 'http://127.0.0.1').pathname);
  if (typeof file === 'number') return send(res, file, file === 403 ? 'forbidden' : 'bad request');
  try {
    let target = file;
    if ((await stat(target)).isDirectory()) target = path.join(target, 'index.html');
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream', 'content-length': body.length, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    send(res, 404, 'not found');
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`serving dist/ at http://127.0.0.1:${server.address().port}/ (Ctrl+C to stop)`);
});

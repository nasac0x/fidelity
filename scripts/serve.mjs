#!/usr/bin/env node
// SERVE — zero-dependency static server for local fidelity runs.
// Exists because the whole pipeline needs a stable localhost URL and `npx serve`
// needs the network and prints noise.
//
//   node serve.mjs --root . --port 3000 [--spa] [--quiet]
// Prints `serving <root> on http://localhost:<port>` once, then stays up
// (run it as a background process and kill it when the gate is done).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, num, str, flag, usage, rel } from './lib/core.mjs';

const A = parseArgs();
const root = path.resolve(str(A.root, '.'));
const port = num(A.port, 3000);
const spa = flag(A.spa);
const quiet = flag(A.quiet);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8', '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.map': 'application/json',
};
if (!fs.existsSync(root)) usage(`serve.mjs --root <dir> [--port 3000] — ${root} does not exist`);

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  let filePath = path.join(root, decodeURIComponent(url.pathname));
  if (!filePath.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
  if (!fs.existsSync(filePath) && spa) filePath = path.join(root, 'index.html');
  if (!fs.existsSync(filePath) && fs.existsSync(path.join(root, '404.html'))) {
    res.writeHead(404, { 'content-type': MIME['.html'] });
    res.end(fs.readFileSync(path.join(root, '404.html')));
    if (!quiet) console.log(`404 ${url.pathname} → 404.html`);
    return;
  }
  if (!fs.existsSync(filePath)) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(filePath).pipe(res);
  if (!quiet) console.log(`${req.method} ${url.pathname} → ${rel(filePath, root)}`);
});

server.listen(port, () => console.log(`serving ${rel(root, process.cwd()) || '.'} on http://localhost:${port}${spa ? ' (spa)' : ''}`));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

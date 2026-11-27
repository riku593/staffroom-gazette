/*
 * Local test harness for the SharePoint version.
 * Runs the compiled board/TV modules (from lib/, after `npm run build`)
 * against an in-memory stand-in for SharePoint, so the ported UI can be
 * exercised without a tenant.
 *
 *   node tools/harness/serve.js   ->  http://localhost:4400/?mode=board  (or ?mode=tv)
 *
 * This does NOT test the real SharePoint REST calls (SharePointHost.ts).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.css': 'text/css', '.pdf': 'application/pdf' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file;
  if (url.pathname === '/') file = path.join(__dirname, 'harness.html');
  else if (url.pathname.startsWith('/lib/')) {
    file = path.join(ROOT, url.pathname);
    if (!path.extname(file) && fs.existsSync(file + '.js')) file += '.js'; // ES module imports without extensions
  } else if (url.pathname.startsWith('/vendor/')) file = path.join(ROOT, '..', 'public', url.pathname);
  else if (url.pathname.startsWith('/samples/')) file = path.join(__dirname, url.pathname);
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(4400, () => console.log('Harness on http://localhost:4400/?mode=board  and  ?mode=tv'));

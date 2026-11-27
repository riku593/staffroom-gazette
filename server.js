/*
 * Staffroom Gazette — a self-hosted company noticeboard.
 * Zero dependencies: runs on plain Node.js (18+).
 *
 *   node server.js            (default port 3000)
 *   PORT=8080 node server.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { analysePdf, suggestFromParagraphs } = require('./lib/pdftext');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'gazette.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_BODY_BYTES = 256 * 1024;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_PDF_BYTES = (parseInt(process.env.MAX_PDF_MB, 10) || 25) * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CATEGORIES = ['General', 'Policy', 'Events', 'Benefits', 'Health & Safety', 'Training', 'People', 'IT & Facilities'];
const PRIORITIES = ['normal', 'important', 'urgent'];
const TV_MODES = ['auto', 'pages', 'text'];

/* ------------------------------------------------------------------ */
/* Storage: a single JSON file, written atomically                     */
/* ------------------------------------------------------------------ */

let db = { users: [], notices: [] };

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db.users = db.users || [];
    db.notices = db.notices || [];
  } else {
    saveDb();
  }
}

function saveDb() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

/* ------------------------------------------------------------------ */
/* Passwords and sessions                                              */
/* ------------------------------------------------------------------ */

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

const sessions = new Map(); // token -> { userId, expires }

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function currentUser(req) {
  const token = parseCookies(req).sg_session;
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  s.expires = Date.now() + SESSION_TTL_MS; // sliding expiry
  return db.users.find((u) => u.id === s.userId) || null;
}

function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt };
}

// Simple brute-force protection on login: 10 failures per IP per 15 minutes.
const loginFailures = new Map();
function tooManyFailures(ip) {
  const rec = loginFailures.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > 15 * 60 * 1000) {
    loginFailures.delete(ip);
    return false;
  }
  return rec.count >= 10;
}
function recordFailure(ip) {
  const rec = loginFailures.get(ip);
  if (!rec || Date.now() - rec.first > 15 * 60 * 1000) loginFailures.set(ip, { first: Date.now(), count: 1 });
  else rec.count++;
}

/* ------------------------------------------------------------------ */
/* Live updates (Server-Sent Events)                                   */
/* ------------------------------------------------------------------ */

const sseClients = new Set();
function broadcast(event) {
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(msg);
}
setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 25000).unref();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] || '';
    // Requiring JSON blocks simple cross-site form posts (CSRF).
    if (!type.startsWith('application/json')) return reject(new HttpError(415, 'Expected application/json'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Files HR can post. The type is decided by the file's contents, not its name.
const FILE_TYPES = {
  pdf: { mime: 'application/pdf', kind: 'pdf', test: (b) => b.subarray(0, 1024).includes('%PDF-') },
  jpg: { mime: 'image/jpeg', kind: 'image', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png: { mime: 'image/png', kind: 'image', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  webp: { mime: 'image/webp', kind: 'image', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};
const UPLOAD_EXTS = Object.keys(FILE_TYPES);
const UPLOAD_MIMES = UPLOAD_EXTS.map((e) => FILE_TYPES[e].mime);

function readUpload(req) {
  return new Promise((resolve, reject) => {
    const type = (req.headers['content-type'] || '').split(';')[0].trim();
    if (!UPLOAD_MIMES.includes(type)) return reject(new HttpError(415, 'Only PDF, JPG, PNG or WebP files can be posted'));
    const tooBig = () => new HttpError(413, `That file is too large (max ${MAX_PDF_BYTES / 1048576} MB)`);
    if (parseInt(req.headers['content-length'], 10) > MAX_PDF_BYTES) return reject(tooBig());
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_PDF_BYTES) {
        reject(tooBig());
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ext = buf.length >= 12 ? UPLOAD_EXTS.find((e) => FILE_TYPES[e].test(buf)) : null;
      if (!ext) return reject(new HttpError(400, "That file doesn't look like a valid PDF, JPG, PNG or WebP"));
      resolve({ buf, ext });
    });
    req.on('error', reject);
  });
}

const uploadPath = (id, ext = 'pdf') => path.join(UPLOAD_DIR, `${id}.${ext}`);

// Find an uploaded file whatever its type. Returns { path, ext } or null.
function uploadFile(id) {
  if (!UUID_RE.test(id || '')) return null;
  for (const ext of UPLOAD_EXTS) {
    const p = uploadPath(id, ext);
    if (fs.existsSync(p)) return { path: p, ext };
  }
  return null;
}
const infoPath = (id) => path.join(UPLOAD_DIR, `${id}.json`);

// What we read out of a PDF (its text etc.) is kept next to it as <id>.json.
// Images have no text inside; the editor reads them with OCR and HR checks the result.
async function analyseUpload(id) {
  const f = uploadFile(id);
  let info = { pages: 1, text: '', hasText: false, textHeavy: false, suggestions: null };
  if (f && f.ext === 'pdf') {
    info.pages = null;
    try {
      info = await analysePdf(fs.readFileSync(f.path), { categories: CATEGORIES });
    } catch (err) {
      console.error(`  Could not read text from PDF ${id}: ${err.message}`);
    }
  }
  const ext = f ? f.ext : 'pdf';
  info = { ...info, kind: FILE_TYPES[ext].kind, ext };
  const { suggestions, ...stored } = info;
  fs.writeFileSync(infoPath(id), JSON.stringify(stored));
  return info;
}

function readInfo(id) {
  try {
    return JSON.parse(fs.readFileSync(infoPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function removeUpload(id) {
  if (id && UUID_RE.test(id)) {
    for (const ext of UPLOAD_EXTS) fs.rm(uploadPath(id, ext), { force: true }, () => {});
    fs.rm(infoPath(id), { force: true }, () => {});
  }
}

// Delete uploaded PDFs that no notice uses (e.g. uploaded, then the editor was cancelled).
function cleanOrphanUploads() {
  const used = new Set(db.notices.map((n) => n.attachment && n.attachment.id).filter(Boolean));
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const id = f.replace(/\.[a-z]+$/, '');
    if (used.has(id)) continue;
    const full = path.join(UPLOAD_DIR, f);
    if (Date.now() - fs.statSync(full).mtimeMs > 24 * 60 * 60 * 1000) fs.rmSync(full, { force: true });
  }
}

function validateAttachment(a, user) {
  if (!a) return null;
  if (typeof a !== 'object' || !UUID_RE.test(a.id || '')) throw new HttpError(400, 'Invalid attachment');
  const f = uploadFile(a.id);
  if (!f) throw new HttpError(400, 'The attached file could not be found. Please upload it again.');
  const info = readInfo(a.id) || {};
  let text = info.text || '';
  let textSource = info.hasText ? 'pdf' : null;
  let ocr = null;
  if (!info.hasText) {
    // Text read from an image (OCR) is only accepted once HR has checked it.
    if (typeof a.ocrText === 'string') {
      if (a.ocrVerified !== true) throw new HttpError(400, 'Please check the text read from the image and confirm it before publishing.');
      text = str(a.ocrText, 15000, 'Text from the image');
      const confidence = Number(a.ocrConfidence);
      ocr = {
        verifiedBy: user ? user.displayName : 'HR',
        verifiedAt: new Date().toISOString(),
        confidence: Number.isFinite(confidence) ? Math.round(Math.min(100, Math.max(0, confidence))) : null,
      };
      fs.writeFileSync(infoPath(a.id), JSON.stringify({ ...info, ocrText: text, ocr }));
    } else if (info.ocrText) {
      text = info.ocrText;
      ocr = info.ocr || null;
    }
    if (text) textSource = 'ocr';
    else ocr = null;
  }
  return {
    id: a.id,
    name: str(a.name, 200, 'File name') || `notice.${f.ext}`,
    size: fs.statSync(f.path).size,
    kind: FILE_TYPES[f.ext].kind,
    ext: f.ext,
    pages: info.pages || null,
    hasText: !!info.hasText,
    textHeavy: !!info.hasText && !!info.textHeavy,
    text,
    textSource,
    ocr,
  };
}

function str(v, max, field, required = false) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text`);
  v = v.trim();
  if (required && !v) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return v;
}

function optDate(v, field) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (isNaN(d)) throw new HttpError(400, `${field} is not a valid date`);
  return d.toISOString();
}

function validateNotice(input, user) {
  const attachment = validateAttachment(input.attachment, user);
  const notice = {
    title: str(input.title, 150, 'Title', true),
    body: str(input.body, 10000, 'Message', !attachment),
    attachment,
    tvMode: TV_MODES.includes(input.tvMode) ? input.tvMode : 'auto',
    category: CATEGORIES.includes(input.category) ? input.category : 'General',
    priority: PRIORITIES.includes(input.priority) ? input.priority : 'normal',
    pinned: !!input.pinned,
    publishAt: optDate(input.publishAt, 'Publish date'),
    expiresAt: optDate(input.expiresAt, 'Expiry date'),
  };
  if (notice.publishAt && notice.expiresAt && notice.expiresAt <= notice.publishAt) {
    throw new HttpError(400, 'Expiry date must be after the publish date');
  }
  return notice;
}

function isLive(n, now = new Date().toISOString()) {
  return (!n.publishAt || n.publishAt <= now) && (!n.expiresAt || n.expiresAt > now);
}

function sortNotices(list) {
  const rank = { urgent: 0, important: 1, normal: 2 };
  return list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
    const da = a.publishAt || a.createdAt;
    const dbb = b.publishAt || b.createdAt;
    return dbb.localeCompare(da);
  });
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Please sign in');
  return user;
}

function sessionCookie(token, maxAgeSec) {
  return `sg_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
}

/* ------------------------------------------------------------------ */
/* API routes                                                          */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname;
  const ip = req.socket.remoteAddress;

  // ---- Setup & auth --------------------------------------------------
  if (p === '/api/status' && method === 'GET') {
    const user = currentUser(req);
    return send(res, 200, {
      needsSetup: db.users.length === 0,
      canSetup: canSetup(req),
      user: user ? publicUser(user) : null,
      categories: CATEGORIES,
      priorities: PRIORITIES,
      maxPdfMb: MAX_PDF_BYTES / 1048576,
    });
  }

  if (p === '/api/setup' && method === 'POST') {
    if (db.users.length > 0) throw new HttpError(403, 'Setup has already been completed');
    if (!canSetup(req)) {
      throw new HttpError(403, 'For security, the first admin account must be created on the server computer itself (open http://localhost:' + PORT + ').');
    }
    const body = await readJson(req);
    const user = makeUser(body);
    db.users.push(user);
    saveDb();
    const token = createSession(user.id);
    return send(res, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
  }

  if (p === '/api/login' && method === 'POST') {
    if (tooManyFailures(ip)) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    const body = await readJson(req);
    const username = String(body.username || '').trim().toLowerCase();
    const user = db.users.find((u) => u.username === username);
    if (!user || !verifyPassword(String(body.password || ''), user)) {
      recordFailure(ip);
      throw new HttpError(401, 'Incorrect username or password');
    }
    loginFailures.delete(ip);
    const token = createSession(user.id);
    return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
  }

  if (p === '/api/logout' && method === 'POST') {
    const token = parseCookies(req).sg_session;
    if (token) sessions.delete(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (p === '/api/password' && method === 'POST') {
    const user = requireUser(req);
    const body = await readJson(req);
    if (!verifyPassword(String(body.currentPassword || ''), user)) throw new HttpError(400, 'Current password is incorrect');
    const pw = String(body.newPassword || '');
    if (pw.length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
    Object.assign(user, hashPassword(pw));
    saveDb();
    return send(res, 200, { ok: true });
  }

  // ---- Live updates --------------------------------------------------
  if (p === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 5000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ---- Uploads (PDFs and images) -----------------------------------
  if (p === '/api/uploads' && method === 'POST') {
    requireUser(req);
    const { buf, ext } = await readUpload(req);
    const id = crypto.randomUUID();
    fs.writeFileSync(uploadPath(id, ext), buf);
    let name = `notice.${ext}`;
    try { name = decodeURIComponent(req.headers['x-filename'] || '') || name; } catch { /* keep default */ }
    name = name.replace(/[\r\n"\\/]/g, '').slice(0, 200);
    const info = await analyseUpload(id);
    return send(res, 201, {
      attachment: { id, name, size: buf.length, kind: info.kind, ext, pages: info.pages, hasText: info.hasText, textHeavy: info.textHeavy },
      suggestions: info.suggestions,
    });
  }

  // Suggestions for text HR has checked after OCR (same rules as PDF text).
  if (p === '/api/suggest' && method === 'POST') {
    requireUser(req);
    const body = await readJson(req);
    const paras = (Array.isArray(body.paragraphs) ? body.paragraphs : []).slice(0, 400)
      .map((x) => ({ text: String((x && x.text) || '').slice(0, 2000).trim(), size: Number(x && x.size) || 10, y: Number(x && x.y) || 0 }))
      .filter((x) => x.text);
    const pageHeight = Number(body.pageHeight) || 1000;
    const fullText = typeof body.text === 'string' ? body.text.slice(0, 15000) : undefined;
    return send(res, 200, { suggestions: paras.length ? suggestFromParagraphs(paras, pageHeight, CATEGORIES, fullText) : null });
  }

  // ---- Notices -------------------------------------------------------
  if (p === '/api/notices' && method === 'GET') {
    const user = currentUser(req);
    const includeAll = user && url.searchParams.get('all') === '1';
    const now = new Date().toISOString();
    const list = includeAll ? db.notices.slice() : db.notices.filter((n) => isLive(n, now));
    return send(res, 200, { notices: sortNotices(list), serverTime: now });
  }

  if (p === '/api/notices' && method === 'POST') {
    const user = requireUser(req);
    const input = validateNotice(await readJson(req), user);
    const now = new Date().toISOString();
    const notice = {
      id: crypto.randomUUID(),
      ...input,
      authorId: user.id,
      authorName: user.displayName,
      createdAt: now,
      updatedAt: now,
    };
    db.notices.push(notice);
    saveDb();
    broadcast({ type: 'notices' });
    return send(res, 201, { notice });
  }

  const noticeMatch = p.match(/^\/api\/notices\/([\w-]+)$/);
  if (noticeMatch) {
    const notice = db.notices.find((n) => n.id === noticeMatch[1]);
    if (method === 'GET') {
      const user = currentUser(req);
      if (!notice || (!user && !isLive(notice))) throw new HttpError(404, 'Notice not found');
      return send(res, 200, { notice });
    }
    const user = requireUser(req);
    if (!notice) throw new HttpError(404, 'Notice not found');
    if (method === 'PUT') {
      const input = validateNotice(await readJson(req), user);
      const oldId = notice.attachment && notice.attachment.id;
      if (oldId && oldId !== (input.attachment && input.attachment.id)) removeUpload(oldId);
      Object.assign(notice, input, { updatedAt: new Date().toISOString(), editedBy: user.displayName });
      saveDb();
      broadcast({ type: 'notices' });
      return send(res, 200, { notice });
    }
    if (method === 'DELETE') {
      db.notices = db.notices.filter((n) => n.id !== notice.id);
      if (notice.attachment) removeUpload(notice.attachment.id);
      saveDb();
      broadcast({ type: 'notices' });
      return send(res, 200, { ok: true });
    }
  }

  // ---- HR team accounts ---------------------------------------------
  if (p === '/api/users' && method === 'GET') {
    requireUser(req);
    return send(res, 200, { users: db.users.map(publicUser) });
  }

  if (p === '/api/users' && method === 'POST') {
    requireUser(req);
    const user = makeUser(await readJson(req));
    db.users.push(user);
    saveDb();
    return send(res, 201, { user: publicUser(user) });
  }

  const userMatch = p.match(/^\/api\/users\/([\w-]+)$/);
  if (userMatch && method === 'DELETE') {
    const me = requireUser(req);
    if (userMatch[1] === me.id) throw new HttpError(400, "You can't remove your own account");
    const before = db.users.length;
    db.users = db.users.filter((u) => u.id !== userMatch[1]);
    if (db.users.length === before) throw new HttpError(404, 'User not found');
    for (const [token, s] of sessions) if (s.userId === userMatch[1]) sessions.delete(token);
    saveDb();
    return send(res, 200, { ok: true });
  }

  throw new HttpError(404, 'Not found');
}

function canSetup(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || process.env.ALLOW_REMOTE_SETUP === '1';
}

function makeUser(body) {
  const username = str(body.username, 40, 'Username', true).toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(username)) throw new HttpError(400, 'Username may only contain letters, numbers, dots, dashes and underscores');
  if (db.users.some((u) => u.username === username)) throw new HttpError(409, 'That username is already taken');
  const displayName = str(body.displayName, 60, 'Display name', true);
  const password = String(body.password || '');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  return { id: crypto.randomUUID(), username, displayName, ...hashPassword(password), createdAt: new Date().toISOString() };
}

/* ------------------------------------------------------------------ */
/* Uploaded files                                                      */
/* ------------------------------------------------------------------ */

function serveUpload(req, res, url) {
  const m = url.pathname.match(/^\/uploads\/([0-9a-f-]{36})\.(pdf|jpg|png|webp)$/);
  const notFound = () => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); };
  const f = m && uploadFile(m[1]);
  if (!f || f.ext !== m[2]) return notFound();
  const user = currentUser(req);
  const notice = db.notices.find((n) => n.attachment && n.attachment.id === m[1]);
  // Staff can see files on live notices; HR can also see scheduled/expired ones and fresh uploads.
  if (!user && (!notice || !isLive(notice))) return notFound();
  const name = (notice && notice.attachment.name) || `notice.${f.ext}`;
  const download = url.searchParams.get('download') === '1';
  res.writeHead(200, {
    'Content-Type': FILE_TYPES[f.ext].mime,
    'Content-Length': fs.statSync(f.path).size,
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'private, max-age=300',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f.path).pipe(res);
}

/* ------------------------------------------------------------------ */
/* Static files                                                        */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; font-src 'self' data: blob:; style-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'",
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (url.pathname.startsWith('/uploads/')) serveUpload(req, res, url);
    else if (url.pathname === '/tv' || url.pathname === '/tv/') {
      url.pathname = '/tv.html';
      serveStatic(req, res, url);
    }
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else send(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    if (err instanceof HttpError) send(res, err.status, { error: err.message });
    else {
      console.error(err);
      send(res, 500, { error: 'Something went wrong on the server' });
    }
  }
});

loadDb();
cleanOrphanUploads();
(async function readOlderPdfs() {
  const todo = db.notices.filter((n) => n.attachment && (n.attachment.text === undefined || !n.attachment.kind));
  for (const n of todo) {
    if (!uploadFile(n.attachment.id)) continue;
    const info = readInfo(n.attachment.id) && n.attachment.text !== undefined ? readInfo(n.attachment.id) : await analyseUpload(n.attachment.id);
    Object.assign(n.attachment, {
      kind: info.kind || 'pdf', ext: info.ext || 'pdf', pages: info.pages, hasText: info.hasText, textHeavy: info.textHeavy,
      text: n.attachment.text || info.text || '', textSource: n.attachment.textSource || (info.hasText ? 'pdf' : null),
    });
  }
  if (todo.length) {
    saveDb();
    broadcast({ type: 'notices' });
    console.log(`  Read the text of ${todo.length} existing PDF notice(s).`);
  }
})();
setInterval(cleanOrphanUploads, 6 * 60 * 60 * 1000).unref();
server.listen(PORT, HOST, () => {
  console.log('\n  The Staffroom Gazette is running.\n');
  console.log(`  On this computer:   http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  On your network:    http://${a.address}:${PORT}`);
    }
  }
  console.log(`  TV dashboard:       add /tv to either address`);
  if (db.users.length === 0) console.log('\n  First run: open the page and create the first HR admin account.');
  console.log('\n  Press Ctrl+C to stop.\n');
});

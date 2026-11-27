'use strict';

/* Staffroom Gazette — front end (no framework, no build step). */

const state = {
  user: null,
  needsSetup: false,
  canSetup: false,
  categories: [],
  notices: [],
  filter: 'All',
  query: '',
  showAll: false,
  editingId: null,
  editAttachment: null, // PDF already on the server for the notice being edited
  editFile: null, // PDF picked in the editor, not uploaded yet
  maxPdfMb: 25,
  seen: new Set(JSON.parse(localStorage.getItem('sg_seen') || '[]')),
  firstVisit: !localStorage.getItem('sg_seen'),
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c.nodeType ? c : document.createTextNode(c));
  return node;
};

/* ---------------- API ---------------- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------------- Formatting ---------------- */

const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

function relTime(iso) {
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  if (diff < 86400 * 7) {
    const d = Math.floor(diff / 86400);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }
  return dateFmt.format(new Date(iso));
}

const renderRichText = (text) => RichText.render(text);

function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

const isPdf = (file) => file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
const isImage = (file) => file && (/^image\/(jpeg|png|webp)$/.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name));
const isAccepted = (file) => isPdf(file) || isImage(file);
// Uploads with no text inside (images, scanned PDFs) can be read with OCR.
const needsOcr = (a) => !!a && (a.kind === 'image' || a.hasText === false);

function noticeStatus(n) {
  const now = new Date().toISOString();
  if (n.publishAt && n.publishAt > now) return 'scheduled';
  if (n.expiresAt && n.expiresAt <= now) return 'expired';
  return 'live';
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------------- Rendering ---------------- */

function renderDateline() {
  const d = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  $('#dateline').textContent = d;
}

function renderAccount() {
  const box = $('#account');
  box.replaceChildren();
  if (state.user) {
    const menu = el('div', { class: 'menu', hidden: true, role: 'menu' },
      el('button', { role: 'menuitem', onclick: () => openEditor() }, 'Post a new notice'),
      el('button', { role: 'menuitem', onclick: () => window.open('/tv', '_blank', 'noopener') }, 'Open TV display'),
      el('button', { role: 'menuitem', onclick: openTeam }, 'HR team accounts'),
      el('button', { role: 'menuitem', onclick: () => openDialog('#passwordDialog') }, 'Change password'),
      el('button', { role: 'menuitem', onclick: logout }, 'Sign out'),
    );
    const toggle = el('button', {
      class: 'btn small', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: (e) => {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
        toggle.setAttribute('aria-expanded', String(!menu.hidden));
      },
    }, el('span', { class: 'who' }, `${state.user.displayName} · `), 'HR menu ▾');
    menu.addEventListener('click', () => { menu.hidden = true; });
    box.append(toggle, menu);
  } else {
    box.append(el('button', { class: 'btn small ghost', onclick: () => openDialog('#loginDialog') }, 'HR sign in'));
  }
  $('#fab').hidden = !state.user;
  $('#showAllWrap').hidden = !state.user;
}

function renderChips() {
  const chips = $('#chips');
  chips.replaceChildren();
  const counts = {};
  state.notices.forEach((n) => { counts[n.category] = (counts[n.category] || 0) + 1; });
  const cats = ['All', ...state.categories.filter((c) => counts[c])];
  if (state.filter !== 'All' && !counts[state.filter]) state.filter = 'All';
  for (const c of cats) {
    chips.append(el('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(state.filter === c),
      onclick: () => { state.filter = c; renderChips(); renderBoard(); },
    }, c === 'All' ? `All (${state.notices.length})` : `${c} (${counts[c]})`));
  }
}

function filtered() {
  const q = state.query.trim().toLowerCase();
  return state.notices.filter((n) =>
    (state.filter === 'All' || n.category === state.filter) &&
    (!q || `${n.title} ${n.body} ${n.category} ${n.authorName} ${n.attachment ? `${n.attachment.name} ${n.attachment.text || ''}` : ''}`.toLowerCase().includes(q)));
}

// When a search only matches words inside a PDF, show the passage it matched.
function pdfMatchSnippet(n) {
  const q = state.query.trim().toLowerCase();
  if (!q || !n.attachment || !n.attachment.text) return null;
  if (`${n.title} ${n.body} ${n.category} ${n.authorName}`.toLowerCase().includes(q)) return null;
  const text = n.attachment.text.replace(/\s+/g, ' ');
  const at = text.toLowerCase().indexOf(q);
  if (at < 0) return null;
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + q.length + 80);
  return el('p', { class: 'match-snippet' },
    el('span', { class: 'match-label' }, n.attachment.textSource === 'ocr' ? 'In the image (read by OCR): ' : 'In the PDF: '),
    start > 0 ? '…' : '',
    text.slice(start, at),
    el('mark', {}, text.slice(at, at + q.length)),
    text.slice(at + q.length, end),
    end < text.length ? '…' : '');
}

/* PDF thumbnails: rendered lazily as cards scroll into view, and kept so
   board refreshes don't redraw them. */
const thumbCache = new Map(); // attachment id -> { canvas, pages }
const thumbObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        thumbObserver.unobserve(e.target);
        renderThumb(e.target);
      }
    }
  }, { rootMargin: '300px' })
  : null;

function pagesLabel(n) {
  return `PDF · ${n} page${n === 1 ? '' : 's'}`;
}

function imageThumb(n) {
  return el('button', {
    class: 'pdf-thumb ready img-thumb', type: 'button',
    'aria-label': `Open image: ${n.attachment.name}`, onclick: () => openReader(n),
  }, el('img', { src: PdfView.urlFor(n.attachment), alt: '', loading: 'lazy', decoding: 'async' }),
  el('span', { class: 'pdf-tag' }, n.attachment.textSource === 'ocr' ? 'Image · text read by OCR' : 'Image'));
}

function pdfThumb(n) {
  if (n.attachment.kind === 'image') return imageThumb(n);
  const cached = thumbCache.get(n.attachment.id);
  const box = el('button', {
    class: `pdf-thumb ${cached ? 'ready' : ''}`, type: 'button', 'data-id': n.attachment.id, 'data-url': PdfView.urlFor(n.attachment),
    'aria-label': `Open PDF: ${n.attachment.name}`, onclick: () => openReader(n),
  }, cached ? cached.canvas : el('canvas', { 'aria-hidden': 'true' }),
  el('span', { class: 'pdf-tag' }, cached ? pagesLabel(cached.pages) : 'PDF'));
  if (!cached) {
    if (thumbObserver) thumbObserver.observe(box);
    else renderThumb(box);
  }
  return box;
}

async function renderThumb(box) {
  const id = box.dataset.id;
  const canvas = $('canvas', box);
  try {
    const doc = await PdfView.load(box.dataset.url);
    await PdfView.renderPage(doc, 1, canvas, { maxWidth: Math.max(box.clientWidth, 280) });
    thumbCache.set(id, { canvas, pages: doc.numPages });
    box.classList.add('ready');
    $('.pdf-tag', box).textContent = pagesLabel(doc.numPages);
  } catch {
    box.classList.add('failed');
    $('.pdf-tag', box).textContent = 'PDF · preview unavailable';
  }
}

function noticeCard(n) {
  const status = noticeStatus(n);
  const isNew = !state.firstVisit && !state.seen.has(n.id) && status === 'live';
  const kicker = el('div', { class: 'kicker' },
    el('span', {}, n.category),
    n.priority !== 'normal' && el('span', { class: `badge ${n.priority}` }, n.priority),
    n.pinned && el('span', { class: 'badge pinned' }, 'Pinned'),
    isNew && el('span', { class: 'badge new' }, 'New'),
    state.user && status !== 'live' && el('span', { class: 'badge status' },
      status === 'scheduled' ? `Scheduled · ${dateTimeFmt.format(new Date(n.publishAt))}` : 'Expired'),
  );
  const shown = n.publishAt && n.publishAt > n.createdAt ? n.publishAt : n.createdAt;
  const actions = state.user && el('div', { class: 'actions' },
    el('button', { class: 'icon-btn', type: 'button', onclick: () => openEditor(n) }, 'Edit'),
    el('button', { class: 'icon-btn del', type: 'button', onclick: () => removeNotice(n) }, 'Remove'),
  );
  return el('article', { class: `notice ${n.priority} ${status !== 'live' ? 'inactive' : ''}`, id: `n-${n.id}` },
    kicker,
    el('h2', {}, el('button', { type: 'button', onclick: () => openReader(n) }, n.title)),
    n.attachment && pdfThumb(n),
    pdfMatchSnippet(n),
    n.body && el('div', { class: `excerpt ${n.attachment ? 'short' : ''}` }, renderRichText(n.body)),
    el('div', { class: 'byline' },
      el('span', {}, `${n.authorName} · `, el('time', { datetime: shown, title: dateTimeFmt.format(new Date(shown)) }, relTime(shown))),
      actions),
  );
}

function renderBoard() {
  const board = $('#board');
  board.replaceChildren();
  const list = filtered();

  if (!list.length) {
    const hasAny = state.notices.length > 0;
    board.append(el('div', { class: 'empty' },
      el('h2', {}, hasAny ? 'No matching notices' : 'Nothing on the board yet'),
      el('p', {}, hasAny ? 'Try a different search or category.'
        : state.user ? 'Post the first notice with the “New notice” button.' : 'Check back soon for news from HR.'),
    ));
    return;
  }

  const lead = list.filter((n) => n.pinned || n.priority === 'urgent');
  const rest = list.filter((n) => !lead.includes(n));
  if (lead.length) {
    board.append(el('h2', { class: 'section-label' }, 'Front page'),
      el('div', { class: 'grid lead' }, lead.map(noticeCard)));
  }
  if (rest.length) {
    board.append(el('h2', { class: 'section-label' }, lead.length ? 'More notices' : 'Latest notices'),
      el('div', { class: 'grid' }, rest.map(noticeCard)));
  }
}

function markSeen() {
  state.notices.forEach((n) => { if (noticeStatus(n) === 'live') state.seen.add(n.id); });
  localStorage.setItem('sg_seen', JSON.stringify([...state.seen].slice(-500)));
}

/* ---------------- Data loading ---------------- */

async function loadNotices() {
  const data = await api(`/api/notices${state.user && state.showAll ? '?all=1' : ''}`);
  state.notices = data.notices;
  renderChips();
  renderBoard();
  markSeen();
  state.firstVisit = false;
  openFromHash();
}

async function loadStatus() {
  const s = await api('/api/status');
  state.user = s.user;
  state.needsSetup = s.needsSetup;
  state.canSetup = s.canSetup;
  state.categories = s.categories;
  state.maxPdfMb = s.maxPdfMb || 25;
  $('#maxPdf').textContent = state.maxPdfMb;
  const sel = $('#editForm [name=category]');
  sel.replaceChildren(...s.categories.map((c) => el('option', { value: c }, c)));
  renderAccount();
}

function connectLive() {
  const status = $('#liveStatus');
  const es = new EventSource('/api/events');
  es.onopen = () => { status.textContent = 'Live — new notices appear automatically'; status.classList.add('on'); };
  es.onerror = () => { status.textContent = 'Reconnecting…'; status.classList.remove('on'); };
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'notices') loadNotices().catch(() => {});
  };
}

/* ---------------- Dialogs ---------------- */

function openDialog(sel) {
  const d = $(sel);
  const err = $('.form-error', d);
  if (err) err.textContent = '';
  d.showModal();
  return d;
}

document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]')) e.target.closest('dialog').close();
  // Close the HR menu when clicking anywhere else.
  document.querySelectorAll('.account .menu').forEach((m) => { if (!m.contains(e.target)) m.hidden = true; });
});
// Click on the backdrop closes a dialog (except first-run setup).
document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('click', (e) => {
    if (e.target === d && d.id !== 'setupDialog') d.close();
  });
});

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function submitting(form, fn) {
  const btn = $('button:not([type=button])', form);
  const err = $('.form-error', form);
  err.textContent = '';
  btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2800);
}

function confirmDialog(title, text, okLabel = 'Remove') {
  const d = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('button[value=ok]', d).textContent = okLabel;
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

/* Reader */
function openReader(n) {
  const art = $('#readBody');
  const shown = n.publishAt && n.publishAt > n.createdAt ? n.publishAt : n.createdAt;
  const edited = n.updatedAt && n.updatedAt !== n.createdAt;
  art.replaceChildren(
    el('div', { class: 'kicker' }, el('span', {}, n.category),
      n.priority !== 'normal' && el('span', { class: `badge ${n.priority}` }, n.priority)),
    el('h2', {}, n.title),
    el('div', { class: 'meta' },
      `By ${n.authorName} · ${dateTimeFmt.format(new Date(shown))}`,
      edited ? ` · Updated ${relTime(n.updatedAt)}` : '',
      n.expiresAt ? ` · Until ${dateFmt.format(new Date(n.expiresAt))}` : ''),
    n.body && el('div', { class: 'content' }, renderRichText(n.body)),
  );
  const d = $('#readDialog');
  d.classList.toggle('wide', !!n.attachment);
  if (n.attachment) {
    const a = n.attachment;
    const url = PdfView.urlFor(a);
    const isImg = a.kind === 'image';
    art.append(el('div', { class: 'pdf-actions' },
      el('a', { class: 'btn small', href: url, target: '_blank', rel: 'noopener' }, isImg ? 'Open full size' : 'Open in new tab'),
      el('a', { class: 'btn small ghost', href: `${url}?download=1` }, `Download (${fmtSize(a.size)})`)));
    // Text read by OCR is offered alongside, clearly labelled. The image stays the official version.
    if (a.textSource === 'ocr' && a.text) {
      const by = a.ocr && a.ocr.verifiedBy ? `, checked by ${a.ocr.verifiedBy}` : ', checked by HR';
      art.append(el('details', { class: 'ocr-text' },
        el('summary', {}, `Text in this ${isImg ? 'image' : 'document'} (read by OCR${by})`),
        el('p', { class: 'ocr-text-note' }, `This text was read automatically from the ${isImg ? 'image' : 'scan'} and checked by HR, but may still contain small mistakes. If anything differs, the ${isImg ? 'image' : 'document'} itself is correct.`),
        el('div', { class: 'content' }, renderRichText(a.text))));
    }
    if (isImg) {
      art.append(el('div', { class: 'pdf-view' }, el('img', { class: 'notice-image', src: url, alt: a.textSource === 'ocr' ? a.text.slice(0, 500) : n.title })));
    } else {
      const pages = el('div', { class: 'pdf-view' }, el('p', { class: 'muted' }, 'Loading PDF…'));
      art.append(pages);
      // Render after the dialog is open so the page width is known.
      requestAnimationFrame(() => renderAllPages(url, pages));
    }
  }
  if (!d.open) d.showModal();
  if (location.hash !== `#notice-${n.id}`) history.replaceState(null, '', `#notice-${n.id}`);
  d.addEventListener('close', () => history.replaceState(null, '', location.pathname), { once: true });
}

async function renderAllPages(url, container) {
  try {
    const doc = await PdfView.load(url);
    container.replaceChildren();
    const width = container.clientWidth || 600;
    for (let i = 1; i <= doc.numPages; i++) {
      if (!container.isConnected) return; // reader was closed or changed
      const canvas = el('canvas', { class: 'pdf-page', role: 'img', 'aria-label': `Page ${i} of ${doc.numPages}` });
      container.append(canvas);
      await PdfView.renderPage(doc, i, canvas, { maxWidth: width });
    }
  } catch {
    container.replaceChildren(el('p', { class: 'form-error' }, "This PDF couldn't be shown here. Try opening it in a new tab or downloading it."));
  }
}

async function openFromHash() {
  const m = location.hash.match(/^#notice-([\w-]+)$/);
  if (!m || $('#readDialog').open) return;
  let n = state.notices.find((x) => x.id === m[1]);
  if (!n) {
    try { n = (await api(`/api/notices/${m[1]}`)).notice; } catch { return; }
  }
  openReader(n);
}
window.addEventListener('hashchange', openFromHash);

/* Editor */
function setAttachment(attachment, file) {
  state.editAttachment = attachment;
  state.editFile = file;
  const has = !!(attachment || file);
  $('#attachCurrent').hidden = !has;
  $('#attachPick').hidden = has;
  if (has) {
    const pages = attachment && attachment.pages ? ` · ${attachment.pages} page${attachment.pages === 1 ? '' : 's'}` : '';
    $('#attachName').textContent = `${file ? file.name : attachment.name} · ${fmtSize(file ? file.size : attachment.size)}${pages}${file ? ' · reading…' : ''}`;
  }
  // The message is optional when the notice is a PDF.
  const f = $('#editForm');
  f.body.required = !has;
  $('#bodyOptional').hidden = !has;
  // TV display choice only matters for PDFs and images.
  $('#tvModeRow').hidden = !attachment;
  updateTvHint();
  if (!has) {
    $('#pdfSuggest').hidden = true;
    ocrToken++;
    state.ocr = null;
    renderOcr();
  }
}

function updateTvHint() {
  const f = $('#editForm');
  const a = state.editAttachment;
  if (!a) return;
  const what = a.kind === 'image' ? 'image' : 'pages';
  const ocrText = state.ocr && state.ocr.status === 'confirmed' && state.ocr.text;
  const textOption = $('option[value=text]', f.tvMode);
  textOption.disabled = !(a.hasText || ocrText);
  if (textOption.disabled && f.tvMode.value === 'text') f.tvMode.value = 'auto';
  let hint;
  if (a.hasText) {
    hint = a.textHeavy
      ? 'Automatic shows the text. This PDF looks like a letter, which is easier to read from across a room in large type.'
      : 'Automatic shows the pages. This PDF looks like a poster.';
  } else if (ocrText) {
    hint = `Automatic shows the ${what}. You can show the checked OCR text instead; it will be labelled as read by OCR.`;
  } else {
    hint = `Automatic shows the ${what}. To show it as text, read and check its text with OCR first.`;
  }
  $('#tvModeHint').textContent = hint;
}

const tidyFileName = (name) => name.replace(/\.(pdf|jpe?g|png|webp)$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);

/* ---- OCR: read text from images, and let HR check it before it's used ---- */
let ocrToken = 0;

function setOcrPreview() {
  const a = state.editAttachment;
  const box = $('#ocrPreview');
  box.replaceChildren();
  if (!a) return;
  box.href = PdfView.urlFor(a);
  if (a.kind === 'image') box.append(el('img', { src: PdfView.urlFor(a), alt: 'The uploaded image' }));
  else if (state.ocr && state.ocr.preview) box.append(state.ocr.preview);
  else box.append(el('span', { class: 'muted' }, 'Page 1'));
}

function renderOcr() {
  const panel = $('#ocrPanel');
  const o = state.ocr;
  if (!o || !state.editAttachment) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const ta = $('#ocrText');
  const warn = $('#ocrWarn');
  const done = $('#ocrDone');
  const showBody = o.status === 'running' || o.status === 'review';
  $('.ocr-note', panel).hidden = o.status !== 'review';
  $('.ocr-body', panel).hidden = !showBody;
  $('#ocrConfirm').hidden = o.status !== 'review';
  $('#ocrSkip').hidden = !showBody;
  $('#ocrRun').hidden = true;
  panel.classList.toggle('needs-check', o.status === 'review');
  ta.readOnly = o.status !== 'review';
  ta.placeholder = o.status === 'running' ? 'Reading the text from the image…' : 'No text';
  if (o.status === 'running') ta.value = '';
  if (showBody) setOcrPreview();

  const status = {
    running: o.progress || 'Starting…',
    review: Number.isFinite(o.confidence) ? `Confidence ${o.confidence}%` : '',
    confirmed: 'Checked ✓',
    skipped: 'Not used',
    empty: 'No text found',
    failed: 'Failed',
    idle: 'Not read yet',
  }[o.status] || '';
  $('#ocrStatus').textContent = status;

  const warnings = [];
  if (o.status === 'review') {
    if (o.confidence < 70) warnings.push(`The OCR engine wasn't very sure about this text (${o.confidence}% confidence), so expect more mistakes than usual. Check it especially carefully.`);
    if (o.totalPages > o.pagesRead) warnings.push(`Only the first ${o.pagesRead} of ${o.totalPages} pages were read.`);
  }
  warn.textContent = warnings.join(' ');
  warn.hidden = !warnings.length;

  done.replaceChildren();
  const link = (label, fn) => {
    const b = el('button', { type: 'button', class: 'linkish' }, label);
    b.addEventListener('click', fn);
    return b;
  };
  if (o.status === 'confirmed') {
    done.append(`Text checked${o.existing ? '' : ' by you'}. It's saved with the notice for searching, and staff see it marked as read by OCR. `,
      link('Edit the text', () => { state.ocr = { ...o, status: 'review' }; ta.value = o.text; renderOcr(); ta.focus(); }));
  } else if (o.status === 'skipped') {
    done.append("The text from this image won't be used. Staff will still see the image. ",
      o.text ? link('Use the text after all', () => { state.ocr = { ...o, status: 'review' }; ta.value = o.text; renderOcr(); }) : link('Read the text with OCR', runOcr));
  } else if (o.status === 'empty') {
    done.append('No text was found in this image. It will be posted as a picture only. ', link('Try again', runOcr));
  } else if (o.status === 'failed') {
    done.append(`OCR couldn't read this image (${o.error}). You can still post it as a picture. `, link('Try again', runOcr));
  } else if (o.status === 'idle') {
    done.append("This image's text hasn't been read, so it won't show up in searches. ", link('Read the text with OCR', runOcr));
  }
  done.hidden = !done.childNodes.length;
  updateTvHint();
}

async function runOcr() {
  const a = state.editAttachment;
  if (!a) return;
  const token = ++ocrToken;
  state.ocr = { status: 'running' };
  renderOcr();
  const onProgress = (msg) => {
    if (token !== ocrToken) return;
    state.ocr.progress = msg;
    $('#ocrStatus').textContent = msg;
  };
  try {
    const url = PdfView.urlFor(a);
    const input = a.kind === 'image'
      ? { file: state.pickedFile || await (await fetch(url, { credentials: 'same-origin' })).blob() }
      : { pdfUrl: url };
    const result = await Ocr.read({ ...input, onProgress });
    if (token !== ocrToken) return;
    state.ocr = { ...result, status: result.text ? 'review' : 'empty', changed: true };
    $('#ocrText').value = result.text;
    renderOcr();
    if (result.text) $('#ocrPanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (e) {
    if (token !== ocrToken) return;
    state.ocr = { status: 'failed', error: e.message || 'unknown error' };
    renderOcr();
  }
}

// Line up the checked text with the layout OCR found, so the headline can be picked by size.
function alignParagraphs(text, raw) {
  const parts = text.split(/\n{2,}/).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (raw && raw.length === parts.length) return raw.map((p, i) => ({ ...p, text: parts[i] }));
  if (raw && raw.length) return raw;
  return parts.map((t, i) => ({ text: t, size: i === 0 ? 20 : 10, y: 1000 - i * 30 }));
}

$('#ocrConfirm').addEventListener('click', async () => {
  const text = $('#ocrText').value.trim();
  if (!text) {
    state.ocr = { ...state.ocr, status: 'skipped', text: '' };
    renderOcr();
    return;
  }
  state.ocr = { ...state.ocr, status: 'confirmed', text, changed: true, existing: false };
  renderOcr();
  // Only now, with the text checked, fill in the notice from it.
  try {
    const { suggestions } = await api('/api/suggest', {
      method: 'POST',
      body: { paragraphs: alignParagraphs(text, state.ocr.paragraphs), pageHeight: state.ocr.pageHeight, text },
    });
    applySuggestions(state.editAttachment, suggestions, { name: state.editAttachment.name }, 'ocr');
  } catch { /* suggestions are a nice-to-have */ }
});

$('#ocrSkip').addEventListener('click', () => {
  ocrToken++; // ignore a read that's still running
  const o = state.ocr || {};
  state.ocr = { ...o, status: 'skipped', text: o.status === 'review' ? $('#ocrText').value.trim() : o.text };
  renderOcr();
});
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

let pickToken = 0;
async function pickPdf(file) {
  const err = $('#editForm .form-error');
  if (!isAccepted(file)) {
    err.textContent = 'Please choose a PDF, JPG, PNG or WebP file.';
    return;
  }
  if (file.size > state.maxPdfMb * 1048576) {
    err.textContent = `That file is ${fmtSize(file.size)}. The limit is ${state.maxPdfMb} MB.`;
    return;
  }
  err.textContent = '';
  const token = ++pickToken;
  ocrToken++;
  state.ocr = null;
  state.pickedFile = null;
  renderOcr();
  $('#pdfSuggest').hidden = true;
  setAttachment(null, file);
  $('#editSubmit').disabled = true;
  try {
    // Upload straight away so the server can read the PDF and suggest the details.
    const { attachment, suggestions } = await uploadPdf(file);
    if (token !== pickToken || !$('#editDialog').open) return;
    setAttachment(attachment, null);
    if (needsOcr(attachment)) {
      // No text inside: read it with OCR, and fill nothing in until HR has checked it.
      if (!$('#editForm').title.value.trim()) {
        $('#editForm').title.value = tidyFileName(file.name);
        state.titleAuto = true;
      }
      state.pickedFile = file;
      runOcr();
    } else {
      applySuggestions(attachment, suggestions, file);
    }
  } catch (e) {
    if (token !== pickToken) return;
    setAttachment(null, null);
    err.textContent = e.message;
  } finally {
    if (token === pickToken) $('#editSubmit').disabled = false;
  }
}

function applySuggestions(attachment, s, file, source = 'pdf') {
  const f = $('#editForm');
  const before = { title: f.title.value, body: f.body.value, category: f.category.value };
  const filled = [];
  if (s && s.title && (!f.title.value.trim() || state.titleAuto)) {
    f.title.value = s.title;
    filled.push('headline');
  } else if (!f.title.value.trim()) {
    f.title.value = tidyFileName(file.name);
  }
  if (f.title.value !== before.title) state.titleAuto = true;
  if (s && s.summary && !f.body.value.trim()) {
    f.body.value = s.summary;
    filled.push('summary');
  }
  if (s && s.category && !state.categoryTouched && f.category.value === 'General') {
    f.category.value = s.category;
    filled.push(`category (${s.category})`);
  }

  const box = $('#pdfSuggest');
  box.replaceChildren();
  if (filled.length) {
    const list = filled.length > 1 ? `${filled.slice(0, -1).join(', ')} and ${filled[filled.length - 1]}` : filled[0];
    const undo = el('button', { type: 'button', class: 'linkish' }, 'Undo');
    const from = source === 'ocr' ? 'the text you checked' : 'the PDF';
    const line = el('p', {}, `Filled in the ${list} from ${from}. Please check them before publishing. `, undo);
    undo.addEventListener('click', () => {
      f.title.value = before.title || tidyFileName(file.name);
      f.body.value = before.body;
      f.category.value = before.category;
      line.remove();
      box.hidden = !box.children.length;
    });
    box.append(line);
  }
  if (s && s.dates && s.dates.length) {
    const chips = s.dates.map((iso) => {
      const [y, m, d] = iso.split('-').map(Number);
      const chip = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false' }, dayFmt.format(new Date(y, m - 1, d)));
      chip.addEventListener('click', () => {
        // Take it down at the start of the following day.
        f.expiresAt.value = toLocalInput(new Date(y, m - 1, d + 1).toISOString());
        box.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
      });
      return chip;
    });
    box.append(el('div', { class: 'suggest-dates' }, el('span', {}, `The ${source === 'ocr' ? 'text' : 'PDF'} mentions these dates. Take the notice down after:`), ...chips));
  }
  box.hidden = !box.children.length;
}

async function uploadPdf(file) {
  const res = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name) },
    body: file,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
}

$('#editForm').title.addEventListener('input', () => { state.titleAuto = false; });
$('#editForm').category.addEventListener('change', () => { state.categoryTouched = true; });

$('#attachInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) pickPdf(file);
});
$('#attachRemove').addEventListener('click', () => setAttachment(null, null));

function openEditor(n = null) {
  state.editingId = n ? n.id : null;
  state.titleAuto = false;
  state.categoryTouched = !!n;
  pickToken++; // ignore any upload still running from a previous editor
  const f = $('#editForm');
  f.reset();
  f.tvMode.value = (n && n.tvMode) || 'auto';
  state.pickedFile = null;
  setAttachment(n ? n.attachment || null : null, null);
  const a = n && n.attachment;
  ocrToken++;
  state.ocr = needsOcr(a)
    ? (a.textSource === 'ocr' && a.text
      ? { status: 'confirmed', text: a.text, confidence: a.ocr && a.ocr.confidence, changed: false, existing: true }
      : { status: 'idle' })
    : null;
  renderOcr();
  $('#editTitle').textContent = n ? 'Edit notice' : 'New notice';
  $('#editSubmit').textContent = n ? 'Save changes' : 'Publish';
  if (n) {
    f.title.value = n.title;
    f.body.value = n.body;
    f.category.value = n.category;
    f.priority.value = n.priority;
    f.pinned.checked = n.pinned;
    f.publishAt.value = toLocalInput(n.publishAt);
    f.expiresAt.value = toLocalInput(n.expiresAt);
  }
  openDialog('#editDialog');
  f.title.focus();
}

$('#editForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  submitting(f, async () => {
    if (state.editFile) throw new Error('The file is still uploading. Please wait a moment.');
    const o = state.ocr;
    if (o && o.status === 'running') throw new Error('Still reading the text from the image. Please wait a moment, or choose not to use the text.');
    if (o && o.status === 'review') {
      $('#ocrPanel').scrollIntoView({ block: 'center', behavior: 'smooth' });
      $('#ocrText').focus();
      throw new Error('Please check the text read from the image and confirm it (or choose not to use it) before publishing.');
    }
    let attachment = state.editAttachment;
    if (attachment && o) {
      if (o.status === 'confirmed' && o.changed) attachment = { ...attachment, ocrText: o.text, ocrVerified: true, ocrConfidence: o.confidence };
      else if (o.status !== 'confirmed' && attachment.textSource === 'ocr') attachment = { ...attachment, ocrText: '', ocrVerified: true };
    }
    const body = {
      attachment,
      tvMode: f.tvMode.value,
      title: f.title.value,
      body: f.body.value,
      category: f.category.value,
      priority: f.priority.value,
      pinned: f.pinned.checked,
      // datetime-local values are local time; convert to ISO (UTC) for the server.
      publishAt: f.publishAt.value ? new Date(f.publishAt.value).toISOString() : null,
      expiresAt: f.expiresAt.value ? new Date(f.expiresAt.value).toISOString() : null,
    };
    if (state.editingId) await api(`/api/notices/${state.editingId}`, { method: 'PUT', body });
    else await api('/api/notices', { method: 'POST', body });
    $('#editDialog').close();
    toast(state.editingId ? 'Notice updated' : 'Notice published');
    await loadNotices();
  });
});

async function removeNotice(n) {
  if (!(await confirmDialog('Remove this notice?', `“${n.title}” will be taken off the board for everyone. This can't be undone.`))) return;
  try {
    await api(`/api/notices/${n.id}`, { method: 'DELETE' });
    toast('Notice removed');
    await loadNotices();
  } catch (e) {
    toast(e.message);
  }
}

/* Auth */
$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  submitting(e.target, async () => {
    const { user } = await api('/api/login', { method: 'POST', body: formData(e.target) });
    state.user = user;
    $('#loginDialog').close();
    e.target.reset();
    renderAccount();
    toast(`Signed in as ${user.displayName}`);
    await loadNotices();
  });
});

$('#setupForm').addEventListener('submit', (e) => {
  e.preventDefault();
  submitting(e.target, async () => {
    const { user } = await api('/api/setup', { method: 'POST', body: formData(e.target) });
    state.user = user;
    state.needsSetup = false;
    $('#setupDialog').close();
    renderAccount();
    toast('Account created — welcome!');
    await loadNotices();
  });
});

async function logout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  state.showAll = false;
  $('#showAll').checked = false;
  renderAccount();
  toast('Signed out');
  await loadNotices();
}

$('#passwordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  submitting(e.target, async () => {
    await api('/api/password', { method: 'POST', body: formData(e.target) });
    $('#passwordDialog').close();
    e.target.reset();
    toast('Password changed');
  });
});

/* Team */
async function openTeam() {
  openDialog('#teamDialog');
  await renderTeam();
}

async function renderTeam() {
  const list = $('#teamList');
  try {
    const { users } = await api('/api/users');
    list.replaceChildren(...users.map((u) => el('li', {},
      el('div', {}, el('div', {}, u.displayName), el('div', { class: 'uname' }, `@${u.username}`)),
      u.id === state.user.id
        ? el('span', { class: 'muted' }, 'You')
        : el('button', {
          class: 'btn small ghost', type: 'button',
          onclick: async () => {
            if (!(await confirmDialog('Remove team member?', `${u.displayName} will no longer be able to sign in.`))) return;
            try { await api(`/api/users/${u.id}`, { method: 'DELETE' }); toast('Team member removed'); renderTeam(); } catch (err) { toast(err.message); }
          },
        }, 'Remove'),
    )));
  } catch (e) {
    list.replaceChildren(el('li', { class: 'muted' }, e.message));
  }
}

$('#teamForm').addEventListener('submit', (e) => {
  e.preventDefault();
  submitting(e.target, async () => {
    const { user } = await api('/api/users', { method: 'POST', body: formData(e.target) });
    e.target.reset();
    toast(`${user.displayName} added`);
    await renderTeam();
  });
});

/* Toolbar */
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = e.target.value; renderBoard(); }, 120);
});
$('#showAll').addEventListener('change', (e) => { state.showAll = e.target.checked; loadNotices(); });
$('#fab').addEventListener('click', () => openEditor());

/* Drag a PDF anywhere onto the page to post it (HR only). */
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || !state.user) return;
  dragDepth++;
  document.body.classList.add('dropping');
});
window.addEventListener('dragleave', () => {
  if (dragDepth && --dragDepth === 0) document.body.classList.remove('dropping');
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); // never let the browser navigate away to the file
  dragDepth = 0;
  document.body.classList.remove('dropping');
  if (!state.user) return toast('Sign in as HR to post notices');
  const file = [...e.dataTransfer.files].find(isAccepted);
  if (!file) return toast('Only PDF, JPG, PNG or WebP files can be posted');
  if (!$('#editDialog').open) openEditor();
  pickPdf(file);
});

// Keep relative times fresh, and catch scheduled notices going live / expiring.
setInterval(() => { renderDateline(); loadNotices().catch(() => {}); }, 60000);

/* ---------------- Boot ---------------- */

(async function boot() {
  renderDateline();
  try {
    await loadStatus();
    await loadNotices();
    connectLive();
    if (state.needsSetup) {
      if (state.canSetup) openDialog('#setupDialog');
      else {
        $('#board').replaceChildren(el('div', { class: 'empty' },
          el('h2', {}, 'Almost ready'),
          el('p', {}, 'An administrator needs to finish setting up the Gazette on the server computer.')));
      }
    }
  } catch (e) {
    $('#board').replaceChildren(el('div', { class: 'empty' },
      el('h2', {}, 'Can’t reach the Gazette'),
      el('p', {}, 'The server may be offline. Please try again shortly.')));
  }
})();

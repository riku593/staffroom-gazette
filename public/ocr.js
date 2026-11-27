'use strict';

/*
 * OCR (reading text from images) for the editor, using the bundled
 * Tesseract.js. Runs entirely in the browser; nothing leaves the network.
 * The result is always shown to HR to check before it is used.
 */
window.Ocr = (function () {
  const BASE = '/vendor/tesseract/';
  const MAX_SIDE = 2400; // big photos are scaled down: faster, and no less accurate
  let libPromise = null;
  let workerPromise = null;
  let idleTimer = null;
  let progressFn = null;

  function loadLib() {
    if (!libPromise) {
      libPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = BASE + 'tesseract.min.js';
        s.onload = () => resolve(window.Tesseract);
        s.onerror = () => reject(new Error('Could not load the OCR engine'));
        document.head.append(s);
      });
    }
    return libPromise;
  }

  function worker() {
    clearTimeout(idleTimer);
    if (!workerPromise) {
      workerPromise = loadLib().then((T) => T.createWorker('eng', 1, {
        workerPath: BASE + 'worker.min.js',
        corePath: BASE + 'core',
        langPath: BASE + 'lang',
        workerBlobURL: false, // load the worker from our own server (keeps the security policy strict)
        logger: (m) => {
          if (!progressFn) return;
          if (m.status === 'recognizing text') progressFn(`Reading text… ${Math.round(m.progress * 100)}%`);
          else if (/load/i.test(m.status)) progressFn('Starting the OCR engine…');
        },
      }));
      workerPromise.catch(() => { workerPromise = null; });
    }
    return workerPromise;
  }

  // Free the engine's memory when it hasn't been used for a while.
  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      const w = workerPromise;
      workerPromise = null;
      if (w) (await w).terminate();
    }, 3 * 60 * 1000);
  }

  async function imageToCanvas(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close && bitmap.close();
    return canvas;
  }

  async function pdfPagesToCanvases(url, maxPages) {
    const doc = await PdfView.load(url);
    const canvases = [];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
      const canvas = document.createElement('canvas');
      await PdfView.renderPage(doc, i, canvas, { maxWidth: 2000 / dpr });
      canvases.push(canvas);
    }
    return { canvases, totalPages: doc.numPages };
  }

  // Turn Tesseract's blocks into paragraphs with a size (line height) and
  // position, the same shape the server uses for PDF text.
  // Tesseract's own paragraph grouping often merges a big heading into the text
  // below it, so we regroup its lines by height and spacing instead.
  function paragraphsOf(data, pageHeight) {
    const lines = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const l of para.lines || []) {
          const text = l.text.replace(/\s+/g, ' ').trim();
          if (text.replace(/[^\p{L}\p{N}]/gu, '').length < 2) continue; // specks and smudges
          lines.push({ text, top: l.bbox.y0, bottom: l.bbox.y1, height: l.bbox.y1 - l.bbox.y0 });
        }
      }
    }
    lines.sort((a, b) => a.top - b.top);
    const out = [];
    let cur = null;
    let prev = null;
    for (const l of lines) {
      const gap = prev ? l.top - prev.bottom : Infinity;
      const similar = prev && Math.abs(l.height - prev.height) / Math.max(l.height, prev.height) < 0.25;
      if (cur && similar && gap < Math.max(l.height, prev.height) * 0.9) {
        cur.text = /[a-z]-$/.test(cur.text) && /^[a-z]/.test(l.text) ? cur.text.slice(0, -1) + l.text : `${cur.text} ${l.text}`;
        cur.heights.push(l.height);
      } else {
        cur = { text: l.text, heights: [l.height], y: pageHeight - l.top };
        out.push(cur);
      }
      prev = l;
    }
    return out.map((p) => {
      const h = p.heights.sort((a, b) => a - b);
      return { text: p.text, size: h[Math.floor(h.length / 2)], y: p.y };
    });
  }

  /**
   * Read text from an image file, or from the first pages of a scanned PDF.
   * Returns { text, confidence, paragraphs, pageHeight, preview (canvas), pagesRead, totalPages }
   */
  async function read({ file, pdfUrl, maxPages = 3, onProgress }) {
    progressFn = onProgress || null;
    try {
      onProgress && onProgress('Preparing the image…');
      let canvases;
      let totalPages = 1;
      if (pdfUrl) ({ canvases, totalPages } = await pdfPagesToCanvases(pdfUrl, maxPages));
      else canvases = [await imageToCanvas(file)];

      const w = await worker();
      const pageTexts = [];
      const confidences = [];
      let firstParas = [];
      for (let i = 0; i < canvases.length; i++) {
        if (canvases.length > 1) onProgress && onProgress(`Reading page ${i + 1} of ${canvases.length}…`);
        const { data } = await w.recognize(canvases[i], {}, { text: true, blocks: true });
        const paras = paragraphsOf(data, canvases[i].height);
        if (i === 0) firstParas = paras;
        pageTexts.push(paras.map((p) => p.text).join('\n\n'));
        if (paras.length) confidences.push(data.confidence);
      }
      const confidence = confidences.length ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length) : 0;
      return {
        text: pageTexts.filter(Boolean).join('\n\n').trim(),
        confidence,
        paragraphs: firstParas,
        pageHeight: canvases[0].height,
        preview: canvases[0],
        pagesRead: canvases.length,
        totalPages,
      };
    } finally {
      progressFn = null;
      scheduleIdle();
    }
  }

  return { read };
})();

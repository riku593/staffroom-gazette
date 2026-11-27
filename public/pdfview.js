'use strict';

/*
 * Shared PDF rendering for the board and the TV display.
 * Uses the bundled PDF.js (public/vendor/pdfjs) so PDFs look the same on
 * every device — including phones and TV browsers with no PDF viewer.
 */
window.PdfView = (function () {
  const BASE = '/vendor/pdfjs/';
  let libPromise = null;
  const docs = new Map(); // url -> Promise<PDFDocumentProxy>

  function lib() {
    if (!libPromise) {
      libPromise = import(BASE + 'pdf.min.mjs').then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';
        return pdfjs;
      });
    }
    return libPromise;
  }

  function load(url) {
    if (!docs.has(url)) {
      const p = lib().then((pdfjs) => pdfjs.getDocument({
        url,
        withCredentials: true,
        cMapUrl: BASE + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: BASE + 'standard_fonts/',
        wasmUrl: BASE + 'wasm/',
        iccUrl: BASE + 'iccs/',
      }).promise);
      p.catch(() => docs.delete(url)); // allow a retry after a failure
      docs.set(url, p);
    }
    return docs.get(url);
  }

  // Forget cached documents that are no longer needed (keeps TV memory flat).
  function release(keepUrls) {
    for (const [url, p] of docs) {
      if (!keepUrls.has(url)) {
        docs.delete(url);
        p.then((d) => d.loadingTask.destroy()).catch(() => {});
      }
    }
  }

  /**
   * Render one page into a canvas, scaled to fit a box (CSS pixels).
   * mode "width": fill maxWidth; mode "contain": fit inside maxWidth × maxHeight.
   */
  async function renderPage(doc, pageNumber, canvas, { maxWidth, maxHeight = Infinity, mode = 'width' }) {
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    let scale = maxWidth / base.width;
    if (mode === 'contain') scale = Math.min(scale, maxHeight / base.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: scale * dpr });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
    canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
    if (canvas._task) canvas._task.cancel();
    // Pass only the 2D context: rendering stays on this thread and the canvas can be redrawn later.
    const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
    canvas._task = task;
    try {
      await task.promise;
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return false;
      throw err;
    } finally {
      if (canvas._task === task) canvas._task = null;
    }
    return { width: base.width, height: base.height };
  }

  async function pageSize(doc, pageNumber) {
    const page = await doc.getPage(pageNumber);
    const v = page.getViewport({ scale: 1 });
    return { width: v.width, height: v.height };
  }

  // Works for any upload: PDFs and images (older notices have no ext: they're PDFs).
  const urlFor = (attachment) => `/uploads/${attachment.id}.${attachment.ext || 'pdf'}`;

  return { load, release, renderPage, pageSize, urlFor };
})();

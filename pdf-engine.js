/* ===========================================================
   pdf-engine.js — Shared PDF operations
   All tool pages and the unified editor use these functions.
   Depends on pdf-lib (global PDFLib) and pdf.js (global pdfjsLib)
   =========================================================== */

(function () {
  'use strict';

  const Engine = {};

  // ---------- Load ----------
  Engine.loadPdf = async function (file) {
    const bytes = await file.arrayBuffer();
    const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    return { doc, bytes, name: file.name, size: file.size };
  };

  // ---------- Merge ----------
  // Inputs: array of { doc } objects. Returns Uint8Array.
  Engine.merge = async function (loadedDocs) {
    const merged = await PDFLib.PDFDocument.create();
    for (const { doc } of loadedDocs) {
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    return merged.save();
  };

  // ---------- Split ----------
  // Returns array of { name, bytes } — one PDF per range.
  // ranges: array of arrays of page indices (0-based). e.g. [[0,1],[2,3,4]]
  Engine.split = async function (loaded, ranges) {
    const results = [];
    for (let i = 0; i < ranges.length; i++) {
      const out = await PDFLib.PDFDocument.create();
      const copied = await out.copyPages(loaded.doc, ranges[i]);
      copied.forEach(p => out.addPage(p));
      const bytes = await out.save();
      results.push({ name: `${stripExt(loaded.name)}_part${i + 1}.pdf`, bytes });
    }
    return results;
  };

  // ---------- Rotate ----------
  // pageRotations: object mapping page index -> degrees (90, 180, 270, etc.)
  // OR a single number to rotate all pages
  Engine.rotate = async function (loaded, pageRotations) {
    const out = await PDFLib.PDFDocument.load(loaded.bytes, { ignoreEncryption: true });
    const pages = out.getPages();
    if (typeof pageRotations === 'number') {
      pages.forEach(p => {
        const current = p.getRotation().angle;
        p.setRotation(PDFLib.degrees((current + pageRotations) % 360));
      });
    } else {
      Object.entries(pageRotations).forEach(([idx, deg]) => {
        const p = pages[Number(idx)];
        if (!p) return;
        const current = p.getRotation().angle;
        p.setRotation(PDFLib.degrees((current + Number(deg)) % 360));
      });
    }
    return out.save();
  };

  // ---------- Compress ----------
  // Strategy: re-render each page to canvas at reduced DPI, embed as JPEG.
  // quality: 0.4 (high compression) to 0.85 (light compression)
  // dpi: target rendering DPI (72 = small, 150 = good, 200 = high)
  Engine.compress = async function (loaded, opts = {}) {
    const quality = opts.quality ?? 0.7;
    const dpi = opts.dpi ?? 120;
    const pdfjsDoc = await pdfjsLib.getDocument({ data: loaded.bytes.slice(0) }).promise;
    const out = await PDFLib.PDFDocument.create();
    for (let i = 1; i <= pdfjsDoc.numPages; i++) {
      const page = await pdfjsDoc.getPage(i);
      const viewport = page.getViewport({ scale: dpi / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const jpegData = await new Promise(resolve =>
        canvas.toBlob(b => b.arrayBuffer().then(resolve), 'image/jpeg', quality)
      );
      const jpegImage = await out.embedJpg(jpegData);
      const pdfPage = out.addPage([viewport.width, viewport.height]);
      pdfPage.drawImage(jpegImage, { x: 0, y: 0, width: viewport.width, height: viewport.height });
    }
    return out.save();
  };

  // ---------- PDF to Images ----------
  // Returns array of { name, blob, mime }
  Engine.toImages = async function (loaded, opts = {}) {
    const format = opts.format ?? 'png'; // 'png' or 'jpeg'
    const dpi = opts.dpi ?? 150;
    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const ext = format === 'jpeg' ? 'jpg' : 'png';
    const pdfjsDoc = await pdfjsLib.getDocument({ data: loaded.bytes.slice(0) }).promise;
    const results = [];
    for (let i = 1; i <= pdfjsDoc.numPages; i++) {
      const page = await pdfjsDoc.getPage(i);
      const viewport = page.getViewport({ scale: dpi / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      if (format === 'jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise(r =>
        canvas.toBlob(r, mime, format === 'jpeg' ? 0.92 : undefined)
      );
      results.push({
        name: `${stripExt(loaded.name)}_page${String(i).padStart(2, '0')}.${ext}`,
        blob, mime
      });
    }
    return results;
  };

  // ---------- Render thumbnails for the editor ----------
  Engine.renderThumbnails = async function (loaded, opts = {}) {
    const scale = opts.scale ?? 0.35;
    const pdfjsDoc = await pdfjsLib.getDocument({ data: loaded.bytes.slice(0) }).promise;
    const thumbs = [];
    for (let i = 1; i <= pdfjsDoc.numPages; i++) {
      const page = await pdfjsDoc.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      thumbs.push({ pageIndex: i - 1, dataUrl: canvas.toDataURL('image/png'), width: viewport.width, height: viewport.height });
    }
    return thumbs;
  };

  // ---------- Sign / Add image overlay ----------
  // overlay: { pageIndex, imageBytes, mime ('image/png' or 'image/jpeg'), x, y, width, height }
  // (x, y) in PDF coordinates, origin bottom-left, points (1pt = 1/72 inch)
  Engine.addImageOverlay = async function (loaded, overlays) {
    const out = await PDFLib.PDFDocument.load(loaded.bytes, { ignoreEncryption: true });
    const pages = out.getPages();
    for (const o of overlays) {
      const page = pages[o.pageIndex];
      if (!page) continue;
      const img = o.mime === 'image/jpeg'
        ? await out.embedJpg(o.imageBytes)
        : await out.embedPng(o.imageBytes);
      page.drawImage(img, { x: o.x, y: o.y, width: o.width, height: o.height });
    }
    return out.save();
  };

  // ---------- Add text overlay (annotate) ----------
  // overlays: [{ pageIndex, text, x, y, size, color: {r,g,b} (0-1) }]
  Engine.addTextOverlay = async function (loaded, overlays) {
    const out = await PDFLib.PDFDocument.load(loaded.bytes, { ignoreEncryption: true });
    const font = await out.embedFont(PDFLib.StandardFonts.Helvetica);
    const pages = out.getPages();
    for (const o of overlays) {
      const page = pages[o.pageIndex];
      if (!page) continue;
      const color = o.color || { r: 0, g: 0, b: 0 };
      page.drawText(o.text, {
        x: o.x, y: o.y,
        size: o.size ?? 14,
        font,
        color: PDFLib.rgb(color.r, color.g, color.b)
      });
    }
    return out.save();
  };

  // ---------- Helpers ----------
  function stripExt(name) {
    return name.replace(/\.[^.]+$/, '');
  }
  Engine.stripExt = stripExt;

  window.PDFEngine = Engine;
})();

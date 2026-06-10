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

  // ---------- Fonts ----------
  // Five common document fonts. Arial/Times/Courier map to the built-in PDF
  // standard fonts (no embedding). Calibri/Georgia use OFL, metric-compatible
  // substitutes (Carlito / Gelasio) embedded on demand via fontkit.
  const FONT_FAMILIES = {
    arial: {
      label: 'Arial', css: 'Arial, Helvetica, sans-serif', kind: 'standard',
      std: { regular: 'Helvetica', bold: 'HelveticaBold', italic: 'HelveticaOblique', bolditalic: 'HelveticaBoldOblique' }
    },
    times: {
      label: 'Times New Roman', css: '"Times New Roman", Times, serif', kind: 'standard',
      std: { regular: 'TimesRoman', bold: 'TimesRomanBold', italic: 'TimesRomanItalic', bolditalic: 'TimesRomanBoldItalic' }
    },
    courier: {
      label: 'Courier', css: '"Courier New", Courier, monospace', kind: 'standard',
      std: { regular: 'Courier', bold: 'CourierBold', italic: 'CourierOblique', bolditalic: 'CourierBoldOblique' }
    },
    calibri: {
      label: 'Calibri', css: 'Calibri, Carlito, sans-serif', kind: 'embed',
      url: {
        regular: 'https://cdn.jsdelivr.net/gh/googlefonts/carlito@main/fonts/ttf/Carlito-Regular.ttf',
        bold: 'https://cdn.jsdelivr.net/gh/googlefonts/carlito@main/fonts/ttf/Carlito-Bold.ttf',
        italic: 'https://cdn.jsdelivr.net/gh/googlefonts/carlito@main/fonts/ttf/Carlito-Italic.ttf',
        bolditalic: 'https://cdn.jsdelivr.net/gh/googlefonts/carlito@main/fonts/ttf/Carlito-BoldItalic.ttf'
      }
    },
    georgia: {
      label: 'Georgia', css: 'Georgia, Gelasio, serif', kind: 'embed',
      url: {
        regular: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/gelasio/Gelasio_400Regular.ttf',
        bold: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/gelasio/Gelasio_700Bold.ttf',
        italic: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/gelasio/Gelasio_400Regular_Italic.ttf',
        bolditalic: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/gelasio/Gelasio_700Bold_Italic.ttf'
      }
    }
  };
  Engine.FONT_FAMILIES = FONT_FAMILIES;
  Engine.variantOf = (bold, italic) =>
    bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'regular';

  // Unicode fallback (DejaVu Sans) — broad math/symbol coverage. Used only when
  // the chosen standard font can't encode a character, so symbols never crash export.
  const UNICODE_FALLBACK_URL = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf';

  const _fontBytesCache = {};
  Engine.loadFontBytes = async function (url) {
    if (_fontBytesCache[url]) return _fontBytesCache[url];
    const res = await fetch(url);
    if (!res.ok) throw new Error('Font download failed: ' + url);
    const buf = await res.arrayBuffer();
    _fontBytesCache[url] = buf;
    return buf;
  };

  // ---------- Apply live annotations (text / signature / redact / whiteout) ----------
  // annotations: [{ id, type:'text'|'signature'|'redact', pageIndex,
  //                 x, yTop, w, h,                         // PDF points, bottom-left origin; yTop = top edge
  //                 text, size, color('#rrggbb'), bg('#rrggbb'|null),  // text
  //                 imageBytes, mime }]                     // signature
  // pageRotations: { pageIndex: deltaDegrees } applied on top of each page's own rotation.
  // annotations may also include:
  //   { type:'comment', pageIndex, x, yTop, text }  -> real PDF sticky-note annotation
  // pageCrops: { pageIndex: { x, yTop, w, h } } -> sets the page CropBox.
  Engine.applyAnnotations = async function (loaded, annotations = [], pageRotations = {}, pageCrops = {}) {
    const out = await PDFLib.PDFDocument.load(loaded.bytes, { ignoreEncryption: true });
    const pages = out.getPages();

    // Per-document font resolution + cache.
    const fontCache = new Map();
    let fontkitRegistered = false;
    let unicodeFontPromise = null;
    function ensureFontkit() {
      if (!fontkitRegistered) {
        if (!window.fontkit) throw new Error('fontkit not loaded');
        out.registerFontkit(window.fontkit);
        fontkitRegistered = true;
      }
    }
    async function resolveFont(familyKey, variant) {
      const fam = FONT_FAMILIES[familyKey] || FONT_FAMILIES.arial;
      const key = (FONT_FAMILIES[familyKey] ? familyKey : 'arial') + ':' + variant;
      if (fontCache.has(key)) return fontCache.get(key);
      let font;
      if (fam.kind === 'standard') {
        font = await out.embedFont(PDFLib.StandardFonts[fam.std[variant]]);
      } else {
        ensureFontkit();
        const bytes = await Engine.loadFontBytes(fam.url[variant]);
        font = await out.embedFont(bytes, { subset: true });
      }
      fontCache.set(key, font);
      return font;
    }
    // Lazily embed the Unicode fallback once.
    function unicodeFont() {
      if (!unicodeFontPromise) {
        unicodeFontPromise = (async () => {
          ensureFontkit();
          const bytes = await Engine.loadFontBytes(UNICODE_FALLBACK_URL);
          return out.embedFont(bytes, { subset: true });
        })();
      }
      return unicodeFontPromise;
    }
    // Standard PDF fonts throw on non-WinAnsi glyphs; pick a font that can encode `s`.
    async function fontForText(preferred, s) {
      try { preferred.widthOfTextAtSize(s, 12); return preferred; }
      catch { return await unicodeFont(); }
    }

    const byPage = {};
    for (const a of annotations) (byPage[a.pageIndex] ||= []).push(a);

    for (const [idxStr, list] of Object.entries(byPage)) {
      const page = pages[Number(idxStr)];
      if (!page) continue;
      for (const a of list) {
        const bottom = a.yTop - a.h;
        if (a.type === 'redact') {
          page.drawRectangle({ x: a.x, y: bottom, width: a.w, height: a.h, color: PDFLib.rgb(0, 0, 0) });
        } else if (a.type === 'signature') {
          const img = a.mime === 'image/jpeg'
            ? await out.embedJpg(a.imageBytes)
            : await out.embedPng(a.imageBytes);
          page.drawImage(img, { x: a.x, y: bottom, width: a.w, height: a.h });
        } else if (a.type === 'text') {
          if (a.bg) {
            const bg = hexToRgb(a.bg);
            // Cover at least the original run (bgW/bgH) and grow if the typed
            // text is larger, so deleting/shortening text never reveals the original.
            const bw = a.bgW != null ? Math.max(a.bgW, a.w || 0) : a.w;
            const bh = a.bgH != null ? Math.max(a.bgH, a.h || 0) : a.h;
            page.drawRectangle({ x: a.x - 1, y: a.yTop - bh, width: bw + 2, height: bh, color: PDFLib.rgb(bg.r, bg.g, bg.b) });
          }
          const text = (a.text || '');
          if (text.trim()) {
            const size = a.size || 14;
            const c = hexToRgb(a.color || '#000000');
            const color = PDFLib.rgb(c.r, c.g, c.b);
            const preferred = await resolveFont(a.font || 'arial', Engine.variantOf(a.bold, a.italic));
            const lineHeight = size * 1.2;
            let baseline = a.yTop - size; // treat yTop as the top of the cap height
            for (const line of text.split('\n')) {
              const font = await fontForText(preferred, line); // swap to Unicode font if needed
              page.drawText(line, { x: a.x, y: baseline, size, font, color });
              if (a.underline && line.trim()) {
                let lineWidth;
                try { lineWidth = font.widthOfTextAtSize(line, size); }
                catch { lineWidth = line.length * size * 0.5; }
                const uy = baseline - size * 0.13;
                page.drawLine({
                  start: { x: a.x, y: uy }, end: { x: a.x + lineWidth, y: uy },
                  thickness: Math.max(0.5, size * 0.06), color
                });
              }
              baseline -= lineHeight;
            }
          }
        } else if (a.type === 'comment') {
          // Real PDF sticky-note (Text) annotation — shows in viewer comment panes.
          const top = a.yTop, w = a.w || 20;
          const noteDict = out.context.obj({
            Type: 'Annot', Subtype: 'Text', Name: 'Comment', Open: false,
            Rect: [a.x, top - w, a.x + w, top],
            Contents: PDFLib.PDFString.of(a.text || ''),
            C: [1, 0.86, 0.27]
          });
          const ref = out.context.register(noteDict);
          let annots = page.node.lookup(PDFLib.PDFName.of('Annots'));
          if (!(annots instanceof PDFLib.PDFArray)) {
            annots = out.context.obj([]);
            page.node.set(PDFLib.PDFName.of('Annots'), annots);
          }
          annots.push(ref);
        }
      }
    }

    // Crops -> CropBox (applied per page; coords in PDF user space, top-left origin)
    if (pageCrops && Object.keys(pageCrops).length) {
      for (const [idxStr, c] of Object.entries(pageCrops)) {
        const page = pages[Number(idxStr)];
        if (!page || !c) continue;
        const x = Math.max(0, c.x);
        const bottom = c.yTop - c.h;
        page.setCropBox(x, bottom, c.w, c.h);
      }
    }

    if (pageRotations && Object.keys(pageRotations).length) {
      pages.forEach((p, i) => {
        const deg = pageRotations[i];
        if (!deg) return;
        const current = p.getRotation().angle;
        p.setRotation(PDFLib.degrees((current + Number(deg)) % 360));
      });
    }

    return out.save();
  };

  // ---------- Images to PDF ----------
  // images: [{ bytes (ArrayBuffer|Uint8Array), mime }]
  // opts: { pageSize: 'a4'|'letter'|'fit', orientation: 'auto'|'portrait'|'landscape', margin: pt }
  Engine.imagesToPdf = async function (images, opts = {}) {
    const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
    const pageSize = opts.pageSize ?? 'a4';
    const orientation = opts.orientation ?? 'auto';
    const margin = opts.margin ?? 36;
    const out = await PDFLib.PDFDocument.create();
    for (const img of images) {
      let bytes = img.bytes, mime = img.mime;
      if (mime !== 'image/jpeg' && mime !== 'image/png') {
        bytes = await Engine.transcodeToPng(bytes, mime);
        mime = 'image/png';
      }
      const embedded = mime === 'image/jpeg' ? await out.embedJpg(bytes) : await out.embedPng(bytes);
      const iw = embedded.width, ih = embedded.height;
      if (pageSize === 'fit') {
        // Page exactly matches the image (1 px at 96 dpi = 0.75 pt)
        const w = iw * 0.75, h = ih * 0.75;
        out.addPage([w, h]).drawImage(embedded, { x: 0, y: 0, width: w, height: h });
      } else {
        let [pw, ph] = SIZES[pageSize] || SIZES.a4;
        const landscape = orientation === 'landscape' || (orientation === 'auto' && iw > ih);
        if (landscape) [pw, ph] = [ph, pw];
        const page = out.addPage([pw, ph]);
        const scale = Math.min((pw - margin * 2) / iw, (ph - margin * 2) / ih);
        const w = iw * scale, h = ih * scale;
        page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
      }
    }
    return out.save();
  };

  // Decode any browser-supported image (WebP, GIF, BMP…) to PNG bytes via canvas.
  Engine.transcodeToPng = async function (bytes, mime) {
    const blob = new Blob([bytes], { type: mime });
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width; canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    const outBlob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    return outBlob.arrayBuffer();
  };

  // ---------- Assemble (organize pages) ----------
  // sources: array of loaded ({ doc }) objects.
  // sequence: [{ src, page, rotate } | { blank: { w, h } }] — output page order.
  // Duplicates are fine: each entry gets its own copy.
  Engine.assemble = async function (sources, sequence) {
    const out = await PDFLib.PDFDocument.create();
    for (const item of sequence) {
      if (item.blank) {
        out.addPage([item.blank.w || 595.28, item.blank.h || 841.89]);
        continue;
      }
      const [copied] = await out.copyPages(sources[item.src].doc, [item.page]);
      if (item.rotate) {
        const current = copied.getRotation().angle;
        copied.setRotation(PDFLib.degrees(((current + item.rotate) % 360 + 360) % 360));
      }
      out.addPage(copied);
    }
    return out.save();
  };

  // ---------- Watermark ----------
  // opts: {
  //   type: 'text'|'image',
  //   text, fontSize, color '#rrggbb'            (text)
  //   imageBytes, mime, scale (fraction of page width, default 0.4)  (image)
  //   opacity 0..1, rotation degrees CCW,
  //   mode: 'single'|'tiled', position: 'tl|tc|tr|ml|mc|mr|bl|bc|br', margin,
  //   pages: array of page indices (null = all)
  // }
  Engine.watermark = async function (loaded, opts = {}) {
    const out = await PDFLib.PDFDocument.load(loaded.bytes, { ignoreEncryption: true });
    const pages = out.getPages();
    const targets = opts.pages || pages.map((_, i) => i);
    const opacity = opts.opacity ?? 0.3;
    const rotation = opts.rotation ?? 0;
    const rad = rotation * Math.PI / 180;
    const margin = opts.margin ?? 48;
    const mode = opts.mode || 'single';
    const position = opts.position || 'mc';

    let font = null, image = null, size = 0, color = null;
    if (opts.type === 'image') {
      image = opts.mime === 'image/jpeg' ? await out.embedJpg(opts.imageBytes) : await out.embedPng(opts.imageBytes);
    } else {
      font = await out.embedFont(PDFLib.StandardFonts.Helvetica);
      size = opts.fontSize ?? 48;
      const c = hexToRgb(opts.color || '#888888');
      color = PDFLib.rgb(c.r, c.g, c.b);
    }

    for (const idx of targets) {
      const page = pages[idx];
      if (!page) continue;
      const { width: pw, height: ph } = page.getSize();
      let wmW, wmH;
      if (image) {
        wmW = pw * (opts.scale ?? 0.4);
        wmH = wmW * (image.height / image.width);
      } else {
        wmW = font.widthOfTextAtSize(opts.text || '', size);
        wmH = size * 0.7; // approximate cap height of the drawn text box
      }
      // Draw so the watermark's box CENTER lands at (cx, cy) after rotation about its draw origin.
      const drawAt = (cx, cy) => {
        const ox = cx - (Math.cos(rad) * wmW / 2 - Math.sin(rad) * wmH / 2);
        const oy = cy - (Math.sin(rad) * wmW / 2 + Math.cos(rad) * wmH / 2);
        if (image) {
          page.drawImage(image, { x: ox, y: oy, width: wmW, height: wmH, opacity, rotate: PDFLib.degrees(rotation) });
        } else {
          page.drawText(opts.text || '', { x: ox, y: oy, size, font, color, opacity, rotate: PDFLib.degrees(rotation) });
        }
      };
      if (mode === 'tiled') {
        const stepX = Math.max(wmW * 1.6, 120);
        const stepY = Math.max(wmH * 5, 120);
        for (let y = stepY / 2; y < ph + stepY; y += stepY)
          for (let x = stepX / 2; x < pw + stepX; x += stepX)
            drawAt(x, y);
      } else {
        const cx = position.endsWith('l') ? margin + wmW / 2
                 : position.endsWith('r') ? pw - margin - wmW / 2
                 : pw / 2;
        const cy = position.startsWith('t') ? ph - margin - wmH / 2
                 : position.startsWith('b') ? margin + wmH / 2
                 : ph / 2;
        drawAt(cx, cy);
      }
    }
    return out.save();
  };

  // ---------- Page numbers / Bates stamps ----------
  // opts: { position: 'bl'|'bc'|'br'|'tl'|'tc'|'tr', format: '{n}' / 'Page {n} of {total}' / custom,
  //         start, from, to (0-based inclusive range), fontSize, margin, color,
  //         bates: { prefix, digits } | null }
  // {total} = total pages in the document.
  Engine.addPageNumbers = async function (loaded, opts = {}) {
    const out = await PDFLib.PDFDocument.load(loaded.bytes, { ignoreEncryption: true });
    const font = await out.embedFont(PDFLib.StandardFonts.Helvetica);
    const pages = out.getPages();
    const from = Math.max(0, opts.from ?? 0);
    const to = Math.min(pages.length - 1, opts.to ?? pages.length - 1);
    const size = opts.fontSize ?? 11;
    const margin = opts.margin ?? 28;
    const c = hexToRgb(opts.color || '#444444');
    const color = PDFLib.rgb(c.r, c.g, c.b);
    const position = opts.position || 'bc';
    let counter = opts.start ?? 1;
    for (let i = from; i <= to; i++) {
      const page = pages[i];
      let label;
      if (opts.bates) {
        label = (opts.bates.prefix || '') + String(counter).padStart(opts.bates.digits ?? 6, '0');
      } else {
        label = String(opts.format || '{n}')
          .replaceAll('{n}', String(counter))
          .replaceAll('{total}', String(pages.length));
      }
      const { width: pw, height: ph } = page.getSize();
      const tw = font.widthOfTextAtSize(label, size);
      const x = position.endsWith('l') ? margin : position.endsWith('c') ? (pw - tw) / 2 : pw - margin - tw;
      const y = position.startsWith('t') ? ph - margin - size : margin;
      page.drawText(label, { x, y, size, font, color });
      counter++;
    }
    return out.save();
  };

  // ---------- Helpers ----------
  function hexToRgb(hex) {
    const h = String(hex || '#000000').replace('#', '');
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255
    };
  }
  Engine.hexToRgb = hexToRgb;

  function stripExt(name) {
    return name.replace(/\.[^.]+$/, '');
  }
  Engine.stripExt = stripExt;

  window.PDFEngine = Engine;
})();

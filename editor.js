/* ===========================================================
   editor.js — Unified PDF editor controller
   =========================================================== */

(function () {
  'use strict';

  // ---------- State ----------
  const state = {
    loaded: null,           // { doc, bytes, name, size }
    thumbs: [],             // [{ pageIndex, dataUrl, width, height }]
    pageRotations: {},      // { pageIndex: 0|90|180|270 }
    selectedPages: new Set(),
    currentTool: null,
    pdfjsReady: false
  };

  // ---------- DOM ----------
  const $ = sel => document.querySelector(sel);
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  const addInput = $('#add-file-input');
  const sigInput = $('#sig-image-input');
  const emptyEl = $('#editor-empty');
  const loadedEl = $('#editor-loaded');
  const grid = $('#thumb-grid');
  const currentFile = $('#current-file');
  const inspectorTitle = $('#inspector-title');
  const inspectorHint = $('#inspector-hint');
  const inspectorBody = $('#inspector-body');

  // ---------- pdf.js readiness ----------
  if (window.pdfjsLib) state.pdfjsReady = true;
  window.addEventListener('pdfjs-ready', () => { state.pdfjsReady = true; });

  // ---------- File loading ----------
  PDFUtils.attachDropzone({
    dropzone, input: fileInput,
    onFiles: files => loadFile(files[0])
  });

  async function loadFile(file) {
    PDFUtils.setStatus('Loading…');
    try {
      await ensurePdfjs();
      state.loaded = await PDFEngine.loadPdf(file);
      state.pageRotations = {};
      state.selectedPages.clear();
      await renderThumbnails();
      emptyEl.style.display = 'none';
      loadedEl.style.display = 'block';
      currentFile.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 9h6M9 13h6M9 17h4" stroke-linecap="round"/>
        </svg>
        <span class="file-pill-name">${PDFUtils.escapeHTML(state.loaded.name)}</span>
        <span style="color: var(--text-muted); font-size: 12px;">${PDFUtils.formatBytes(state.loaded.size)} · ${state.thumbs.length} pages</span>
      `;
      enableTools();
      showInspector('idle');
      PDFUtils.setStatus('');

      // If a tool was requested via URL hash (e.g. /editor/#sign), open it
      const requested = location.hash.replace('#', '');
      if (requested) {
        const btn = document.querySelector(`[data-tool="${requested}"]`);
        if (btn) btn.click();
      }
    } catch (err) {
      console.error(err);
      PDFUtils.setStatus('Could not open this file. Make sure it is a valid PDF.', 'error');
    }
  }

  async function ensurePdfjs(timeout = 5000) {
    if (state.pdfjsReady) return;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('pdf.js failed to load')), timeout);
      window.addEventListener('pdfjs-ready', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  async function renderThumbnails() {
    state.thumbs = await PDFEngine.renderThumbnails(state.loaded);
    drawGrid();
  }

  function drawGrid() {
    grid.innerHTML = '';
    state.thumbs.forEach(t => {
      const item = document.createElement('div');
      const rot = state.pageRotations[t.pageIndex] || 0;
      item.className = 'thumb-item thumb-rotated' + (state.selectedPages.has(t.pageIndex) ? ' selected' : '');
      item.dataset.page = t.pageIndex;
      item.dataset.rotation = rot;
      item.innerHTML = `
        <img src="${t.dataUrl}" alt="Page ${t.pageIndex + 1}" />
        <span class="thumb-num">${t.pageIndex + 1}</span>
      `;
      item.addEventListener('click', () => togglePage(t.pageIndex));
      grid.appendChild(item);
    });
  }

  function togglePage(idx) {
    if (state.selectedPages.has(idx)) state.selectedPages.delete(idx);
    else state.selectedPages.add(idx);
    drawGrid();
    // Refresh inspector if a selection-aware tool is open
    if (['rotate', 'split', 'delete'].includes(state.currentTool)) {
      showInspector(state.currentTool);
    }
  }

  function enableTools() {
    document.querySelectorAll('.tool-btn').forEach(b => b.disabled = false);
  }

  // ---------- Tool switching ----------
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      if (tool === 'open') { fileInput.click(); return; }
      if (tool === 'add') { addInput.click(); return; }
      if (!state.loaded) return;
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentTool = tool;
      showInspector(tool);
    });
  });

  // ---------- Add file (merge) ----------
  addInput.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    PDFUtils.setStatus('Merging…');
    try {
      const additional = await PDFEngine.loadPdf(file);
      const merged = await PDFEngine.merge([state.loaded, additional]);
      // Re-load merged result as new state
      state.loaded = await PDFEngine.loadPdf(new File([merged], state.loaded.name, { type: 'application/pdf' }));
      state.pageRotations = {};
      state.selectedPages.clear();
      await renderThumbnails();
      currentFile.querySelector('span:last-child').textContent =
        `${PDFUtils.formatBytes(state.loaded.size)} · ${state.thumbs.length} pages`;
      PDFUtils.setStatus(`Added ${file.name}.`, 'success');
    } catch (err) {
      console.error(err);
      PDFUtils.setStatus('Could not merge that file.', 'error');
    }
    addInput.value = '';
  });

  // ---------- Inspector renderers ----------
  function showInspector(tool) {
    inspectorBody.innerHTML = '';

    if (tool === 'idle') {
      inspectorTitle.textContent = 'Ready to edit';
      inspectorHint.textContent = 'Pick a tool on the left, or click pages to select them.';
      return;
    }

    if (tool === 'rotate') {
      inspectorTitle.textContent = 'Rotate pages';
      inspectorHint.textContent = state.selectedPages.size
        ? `${state.selectedPages.size} page(s) selected.`
        : 'Click pages to select, or rotate all pages.';
      inspectorBody.innerHTML = `
        <div class="field-row">
          <button class="btn btn-ghost" id="rot-left" type="button">↺ 90° left</button>
          <button class="btn btn-ghost" id="rot-right" type="button">↻ 90° right</button>
        </div>
        <button class="btn btn-ghost btn-block" id="rot-180" type="button" style="margin-top:8px;">180°</button>
        <div class="inspector-divider"></div>
        <button class="btn btn-primary btn-block" id="rot-apply" type="button">Apply rotation</button>
      `;
      const setRot = deg => {
        const targets = state.selectedPages.size
          ? Array.from(state.selectedPages)
          : state.thumbs.map(t => t.pageIndex);
        targets.forEach(i => {
          const cur = state.pageRotations[i] || 0;
          state.pageRotations[i] = (cur + deg + 360) % 360;
        });
        drawGrid();
      };
      $('#rot-left').onclick = () => setRot(-90);
      $('#rot-right').onclick = () => setRot(90);
      $('#rot-180').onclick = () => setRot(180);
      $('#rot-apply').onclick = async () => {
        PDFUtils.setStatus('Rotating…');
        try {
          const out = await PDFEngine.rotate(state.loaded, state.pageRotations);
          PDFUtils.download(new Blob([out], { type: 'application/pdf' }),
            `${PDFEngine.stripExt(state.loaded.name)}_rotated.pdf`);
          PDFUtils.setStatus('Rotated PDF downloaded.', 'success');
        } catch (e) { PDFUtils.setStatus('Rotation failed.', 'error'); }
      };
      return;
    }

    if (tool === 'split') {
      inspectorTitle.textContent = 'Split / Extract';
      inspectorHint.textContent = state.selectedPages.size
        ? `Will extract ${state.selectedPages.size} selected page(s).`
        : 'Click pages to select, or enter a range below.';
      inspectorBody.innerHTML = `
        <div class="field">
          <label>Page range (e.g. 1-3, 5, 7-9)</label>
          <input type="text" id="split-range" placeholder="leave blank to use selection" />
        </div>
        <button class="btn btn-primary btn-block" id="split-extract" type="button">Extract pages</button>
        <div class="inspector-divider"></div>
        <button class="btn btn-ghost btn-block" id="split-each" type="button">Split into single pages</button>
      `;
      $('#split-extract').onclick = async () => {
        const rangeText = $('#split-range').value.trim();
        let pages;
        if (rangeText) {
          pages = parseRange(rangeText, state.thumbs.length);
          if (!pages.length) { PDFUtils.setStatus('Invalid range.', 'error'); return; }
        } else if (state.selectedPages.size) {
          pages = Array.from(state.selectedPages).sort((a, b) => a - b);
        } else {
          PDFUtils.setStatus('Select pages or enter a range.', 'error'); return;
        }
        PDFUtils.setStatus('Extracting…');
        try {
          const [result] = await PDFEngine.split(state.loaded, [pages]);
          PDFUtils.download(new Blob([result.bytes], { type: 'application/pdf' }), result.name);
          PDFUtils.setStatus('Pages extracted.', 'success');
        } catch (e) { PDFUtils.setStatus('Extraction failed.', 'error'); }
      };
      $('#split-each').onclick = async () => {
        PDFUtils.setStatus('Splitting…');
        try {
          const ranges = state.thumbs.map(t => [t.pageIndex]);
          const results = await PDFEngine.split(state.loaded, ranges);
          for (const r of results) {
            PDFUtils.download(new Blob([r.bytes], { type: 'application/pdf' }), r.name);
            await new Promise(r => setTimeout(r, 120));
          }
          PDFUtils.setStatus(`${results.length} files downloaded.`, 'success');
        } catch (e) { PDFUtils.setStatus('Split failed.', 'error'); }
      };
      return;
    }

    if (tool === 'delete') {
      inspectorTitle.textContent = 'Delete pages';
      inspectorHint.textContent = state.selectedPages.size
        ? `${state.selectedPages.size} page(s) will be removed.`
        : 'Click pages on the left to select which to delete.';
      inspectorBody.innerHTML = `
        <button class="btn btn-primary btn-block" id="del-apply" type="button" ${!state.selectedPages.size ? 'disabled style="opacity:0.5"' : ''}>
          Delete selected & download
        </button>
      `;
      const btn = $('#del-apply');
      if (btn) btn.onclick = async () => {
        const keep = state.thumbs
          .map(t => t.pageIndex)
          .filter(i => !state.selectedPages.has(i));
        if (!keep.length) { PDFUtils.setStatus('You must keep at least one page.', 'error'); return; }
        PDFUtils.setStatus('Removing pages…');
        try {
          const [result] = await PDFEngine.split(state.loaded, [keep]);
          PDFUtils.download(new Blob([result.bytes], { type: 'application/pdf' }),
            `${PDFEngine.stripExt(state.loaded.name)}_edited.pdf`);
          PDFUtils.setStatus('Done.', 'success');
        } catch (e) { PDFUtils.setStatus('Delete failed.', 'error'); }
      };
      return;
    }

    if (tool === 'annotate') {
      inspectorTitle.textContent = 'Add text';
      inspectorHint.textContent = 'Adds text to the first selected page (or page 1).';
      inspectorBody.innerHTML = `
        <div class="field">
          <label>Text</label>
          <textarea id="ann-text" rows="2" placeholder="Type the text to add…"></textarea>
        </div>
        <div class="field-row">
          <div class="field"><label>X (pt from left)</label><input type="number" id="ann-x" value="50" /></div>
          <div class="field"><label>Y (pt from bottom)</label><input type="number" id="ann-y" value="700" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Size</label><input type="number" id="ann-size" value="14" /></div>
          <div class="field"><label>Color</label><input type="color" id="ann-color" value="#000000" /></div>
        </div>
        <button class="btn btn-primary btn-block" id="ann-apply" type="button">Add text & download</button>
      `;
      $('#ann-apply').onclick = async () => {
        const text = $('#ann-text').value.trim();
        if (!text) { PDFUtils.setStatus('Enter some text first.', 'error'); return; }
        const pageIndex = state.selectedPages.size ? Math.min(...state.selectedPages) : 0;
        const hex = $('#ann-color').value;
        const color = { r: parseInt(hex.slice(1,3),16)/255, g: parseInt(hex.slice(3,5),16)/255, b: parseInt(hex.slice(5,7),16)/255 };
        PDFUtils.setStatus('Adding text…');
        try {
          const out = await PDFEngine.addTextOverlay(state.loaded, [{
            pageIndex, text,
            x: Number($('#ann-x').value), y: Number($('#ann-y').value),
            size: Number($('#ann-size').value), color
          }]);
          PDFUtils.download(new Blob([out], { type: 'application/pdf' }),
            `${PDFEngine.stripExt(state.loaded.name)}_annotated.pdf`);
          PDFUtils.setStatus('Annotated PDF downloaded.', 'success');
        } catch (e) { PDFUtils.setStatus('Could not add text.', 'error'); }
      };
      return;
    }

    if (tool === 'sign') {
      inspectorTitle.textContent = 'Sign PDF';
      inspectorHint.textContent = 'Draw your signature, choose a position, and apply.';
      inspectorBody.innerHTML = `
        <div class="field">
          <label>Draw signature</label>
          <canvas id="sig-pad" class="sig-pad"></canvas>
          <div class="field-row" style="margin-top:6px;">
            <button class="btn btn-ghost" id="sig-clear" type="button" style="padding:6px 12px;font-size:13px;">Clear</button>
            <button class="btn btn-ghost" id="sig-upload-btn" type="button" style="padding:6px 12px;font-size:13px;">Upload image</button>
          </div>
        </div>
        <div class="field-row">
          <div class="field"><label>X</label><input type="number" id="sig-x" value="80" /></div>
          <div class="field"><label>Y</label><input type="number" id="sig-y" value="100" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Width</label><input type="number" id="sig-w" value="150" /></div>
          <div class="field"><label>Height</label><input type="number" id="sig-h" value="50" /></div>
        </div>
        <button class="btn btn-primary btn-block" id="sig-apply" type="button">Sign & download</button>
      `;
      setupSigPad();
      $('#sig-clear').onclick = () => clearSig();
      $('#sig-upload-btn').onclick = () => sigInput.click();
      $('#sig-apply').onclick = applySig;
      return;
    }

    if (tool === 'compress') {
      inspectorTitle.textContent = 'Compress PDF';
      inspectorHint.textContent = 'Re-encode pages to reduce file size. Trade quality for size.';
      inspectorBody.innerHTML = `
        <div class="field">
          <label>Compression level</label>
          <select id="comp-level">
            <option value="low">Low — best quality (~30% smaller)</option>
            <option value="medium" selected>Medium — balanced (~50% smaller)</option>
            <option value="high">High — smallest size</option>
          </select>
        </div>
        <button class="btn btn-primary btn-block" id="comp-apply" type="button">Compress & download</button>
      `;
      $('#comp-apply').onclick = async () => {
        const level = $('#comp-level').value;
        const presets = {
          low:    { quality: 0.85, dpi: 150 },
          medium: { quality: 0.7,  dpi: 120 },
          high:   { quality: 0.5,  dpi: 96 }
        };
        PDFUtils.setStatus('Compressing… this may take a moment.');
        try {
          const out = await PDFEngine.compress(state.loaded, presets[level]);
          const saved = ((1 - out.length / state.loaded.size) * 100).toFixed(0);
          PDFUtils.download(new Blob([out], { type: 'application/pdf' }),
            `${PDFEngine.stripExt(state.loaded.name)}_compressed.pdf`);
          PDFUtils.setStatus(saved > 0 ? `Done — ${saved}% smaller.` : 'Done — file was already optimized.', 'success');
        } catch (e) { console.error(e); PDFUtils.setStatus('Compression failed.', 'error'); }
      };
      return;
    }

    if (tool === 'toimage') {
      inspectorTitle.textContent = 'Export as images';
      inspectorHint.textContent = 'Each page becomes a separate image file.';
      inspectorBody.innerHTML = `
        <div class="field">
          <label>Format</label>
          <select id="img-format">
            <option value="png" selected>PNG (lossless)</option>
            <option value="jpeg">JPG (smaller files)</option>
          </select>
        </div>
        <div class="field">
          <label>Resolution</label>
          <select id="img-dpi">
            <option value="96">Screen (96 DPI)</option>
            <option value="150" selected>Standard (150 DPI)</option>
            <option value="300">Print (300 DPI)</option>
          </select>
        </div>
        <button class="btn btn-primary btn-block" id="img-apply" type="button">Export images</button>
      `;
      $('#img-apply').onclick = async () => {
        PDFUtils.setStatus('Rendering pages…');
        try {
          const results = await PDFEngine.toImages(state.loaded, {
            format: $('#img-format').value,
            dpi: Number($('#img-dpi').value)
          });
          for (const r of results) {
            PDFUtils.download(r.blob, r.name);
            await new Promise(r => setTimeout(r, 120));
          }
          PDFUtils.setStatus(`${results.length} images downloaded.`, 'success');
        } catch (e) { console.error(e); PDFUtils.setStatus('Export failed.', 'error'); }
      };
      return;
    }

    if (tool === 'download') {
      inspectorTitle.textContent = 'Download current PDF';
      inspectorHint.textContent = 'Downloads the PDF in its current state (with any pending rotations applied).';
      inspectorBody.innerHTML = `<button class="btn btn-primary btn-block" id="dl-apply" type="button">Download PDF</button>`;
      $('#dl-apply').onclick = async () => {
        PDFUtils.setStatus('Preparing…');
        try {
          let bytes = state.loaded.bytes;
          if (Object.keys(state.pageRotations).length) {
            bytes = await PDFEngine.rotate(state.loaded, state.pageRotations);
          }
          PDFUtils.download(new Blob([bytes], { type: 'application/pdf' }),
            `${PDFEngine.stripExt(state.loaded.name)}_edited.pdf`);
          PDFUtils.setStatus('Downloaded.', 'success');
        } catch (e) { PDFUtils.setStatus('Download failed.', 'error'); }
      };
      return;
    }
  }

  // ---------- Range parsing ----------
  function parseRange(str, max) {
    const out = new Set();
    const parts = str.split(/[,\s]+/).filter(Boolean);
    for (const p of parts) {
      const m = p.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) return [];
      const start = Math.max(1, Math.min(max, Number(m[1])));
      const end = m[2] ? Math.max(1, Math.min(max, Number(m[2]))) : start;
      const [lo, hi] = [Math.min(start, end), Math.max(start, end)];
      for (let i = lo; i <= hi; i++) out.add(i - 1);
    }
    return Array.from(out).sort((a, b) => a - b);
  }

  // ---------- Signature pad ----------
  let sigCtx, sigDrawing = false, sigHasInk = false, sigImage = null;
  function setupSigPad() {
    const pad = $('#sig-pad');
    pad.width = pad.offsetWidth * (window.devicePixelRatio || 1);
    pad.height = pad.offsetHeight * (window.devicePixelRatio || 1);
    sigCtx = pad.getContext('2d');
    sigCtx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
    sigCtx.lineWidth = 2.2;
    sigCtx.lineCap = 'round';
    sigCtx.lineJoin = 'round';
    sigCtx.strokeStyle = '#000';
    sigHasInk = false;
    sigImage = null;

    function pos(e) {
      const r = pad.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      const y = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
      return { x, y };
    }
    pad.addEventListener('pointerdown', e => {
      sigDrawing = true; sigHasInk = true;
      const p = pos(e);
      sigCtx.beginPath();
      sigCtx.moveTo(p.x, p.y);
    });
    pad.addEventListener('pointermove', e => {
      if (!sigDrawing) return;
      const p = pos(e);
      sigCtx.lineTo(p.x, p.y);
      sigCtx.stroke();
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev =>
      pad.addEventListener(ev, () => { sigDrawing = false; })
    );
  }
  function clearSig() {
    const pad = $('#sig-pad');
    if (sigCtx) sigCtx.clearRect(0, 0, pad.width, pad.height);
    sigHasInk = false;
    sigImage = null;
  }
  sigInput.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    sigImage = { bytes: await file.arrayBuffer(), mime: file.type };
    PDFUtils.setStatus('Signature image loaded.', 'success');
    sigInput.value = '';
  });
  async function applySig() {
    const pageIndex = state.selectedPages.size ? Math.min(...state.selectedPages) : 0;
    const pos = {
      x: Number($('#sig-x').value), y: Number($('#sig-y').value),
      width: Number($('#sig-w').value), height: Number($('#sig-h').value)
    };
    let imageBytes, mime;
    if (sigImage) {
      imageBytes = sigImage.bytes; mime = sigImage.mime;
    } else if (sigHasInk) {
      const pad = $('#sig-pad');
      const blob = await new Promise(r => pad.toBlob(r, 'image/png'));
      imageBytes = await blob.arrayBuffer();
      mime = 'image/png';
    } else {
      PDFUtils.setStatus('Draw a signature or upload an image first.', 'error');
      return;
    }
    PDFUtils.setStatus('Signing…');
    try {
      const out = await PDFEngine.addImageOverlay(state.loaded, [{
        pageIndex, imageBytes, mime, ...pos
      }]);
      PDFUtils.download(new Blob([out], { type: 'application/pdf' }),
        `${PDFEngine.stripExt(state.loaded.name)}_signed.pdf`);
      PDFUtils.setStatus('Signed PDF downloaded.', 'success');
    } catch (e) { console.error(e); PDFUtils.setStatus('Signing failed.', 'error'); }
  }

})();

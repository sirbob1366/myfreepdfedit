/* ===========================================================
   editor.js — Live WYSIWYG PDF editor controller
   Renders the actual page to a canvas and lets users place,
   drag, edit, sign and redact directly on the page. Edits are
   kept live in state and baked into the PDF only on export.
   =========================================================== */

(function () {
  'use strict';

  // ---------- State ----------
  const state = {
    loaded: null,            // { doc, bytes, name, size }
    pdfjsDoc: null,          // open pdf.js document (for live re-render)
    numPages: 0,
    currentPage: 0,          // 0-based
    scale: 1.5,
    viewport: null,          // current pdf.js viewport (with rotation)
    annotations: [],         // live edits across all pages
    pageRotations: {},       // { pageIndex: deltaDegrees }
    pageCrops: {},           // { pageIndex: { x, yTop, w, h } } PDF points
    selectedPages: new Set(),// for page ops (rotate/split/delete)
    currentTool: 'select',
    selectedAnnId: null,
    pendingSignature: null,  // { imageBytes, mime, dataUrl, aspect }
    pdfjsReady: false
  };

  const PAGE_OP_TOOLS = ['rotate', 'split', 'delete'];

  // ---------- DOM ----------
  const $ = sel => document.querySelector(sel);
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  const addInput = $('#add-file-input');
  const sigInput = $('#sig-image-input');
  const emptyEl = $('#editor-empty');
  const toolbar = $('#viewer-toolbar');
  const stage = $('#page-stage');
  const canvas = $('#page-canvas');
  const ctx = canvas.getContext('2d');
  const annLayer = $('#ann-layer');
  const textLayer = $('#text-layer');
  const pagesRail = $('#editor-pages');
  const inspectorTitle = $('#inspector-title');
  const inspectorHint = $('#inspector-hint');
  const inspectorBody = $('#inspector-body');
  const navPage = $('#nav-page');
  const navTotal = $('#nav-total');
  const zoomLabel = $('#zoom-label');
  const vtFile = $('#vt-file');
  const actionBar = $('#viewer-actionbar');
  const vaSummary = $('#va-summary');
  const applyBtn = $('#apply-changes');
  const undoBtn = $('#undo-btn');
  const redoBtn = $('#redo-btn');

  const uid = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---------- pdf.js readiness ----------
  if (window.pdfjsLib) state.pdfjsReady = true;
  window.addEventListener('pdfjs-ready', () => { state.pdfjsReady = true; });

  async function ensurePdfjs(timeout = 5000) {
    if (state.pdfjsReady) return;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('pdf.js failed to load')), timeout);
      window.addEventListener('pdfjs-ready', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  // ---------- File loading ----------
  PDFUtils.attachDropzone({ dropzone, input: fileInput, onFiles: files => loadFile(files[0]) });

  async function loadFile(file) {
    PDFUtils.setStatus('Loading…');
    try {
      await ensurePdfjs();
      state.loaded = await PDFEngine.loadPdf(file);
      state.annotations = [];
      state.pageRotations = {};
      state.pageCrops = {};
      state.selectedPages.clear();
      state.selectedAnnId = null;
      state.currentPage = 0;
      await openPdfjs();
      emptyEl.style.display = 'none';
      stage.style.display = 'block';
      toolbar.style.display = 'flex';
      actionBar.style.display = 'flex';
      enableTools();
      setTool('select');
      vtFile.textContent = `${state.loaded.name} · ${PDFUtils.formatBytes(state.loaded.size)}`;
      await renderThumbs();
      await renderPage();
      resetHistory();
      PDFUtils.setStatus('');

      const requested = location.hash.replace('#', '');
      if (requested && document.querySelector(`[data-tool="${requested}"]`)) {
        setTool(requested);
      }
    } catch (err) {
      console.error(err);
      PDFUtils.setStatus('Could not open this file. Make sure it is a valid PDF.', 'error');
    }
  }

  async function openPdfjs() {
    state.pdfjsDoc = await pdfjsLib.getDocument({ data: state.loaded.bytes.slice(0) }).promise;
    state.numPages = state.pdfjsDoc.numPages;
    navTotal.textContent = state.numPages;
  }

  function enableTools() {
    document.querySelectorAll('.tool-btn').forEach(b => b.disabled = false);
  }

  // ---------- Coordinate helpers (viewport <-> PDF points) ----------
  function toView(pdfX, pdfY) {
    const [x, y] = state.viewport.convertToViewportPoint(pdfX, pdfY);
    return { x, y };
  }
  function toPdf(viewX, viewY) {
    const [x, y] = state.viewport.convertToPdfPoint(viewX, viewY);
    return { x, y };
  }
  // Stage-relative coordinates from a pointer event
  function stagePoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---------- Page rendering ----------
  async function renderPage() {
    if (!state.pdfjsDoc) return;
    const idx = state.currentPage;
    const page = await state.pdfjsDoc.getPage(idx + 1);
    const rotation = ((page.rotate || 0) + (state.pageRotations[idx] || 0)) % 360;
    const viewport = page.getViewport({ scale: state.scale, rotation });
    state.viewport = viewport;

    const ratio = Math.min(2, window.devicePixelRatio || 1); // cap for mobile memory
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    stage.style.width = viewport.width + 'px';
    stage.style.height = viewport.height + 'px';

    const transform = ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null;
    await page.render({ canvasContext: ctx, viewport, transform }).promise;

    renderOverlay();
    if (state.currentTool === 'edittext') renderTextLayer(page);
    else clearTextLayer();

    navPage.value = idx + 1;
    zoomLabel.textContent = Math.round(state.scale * 100) + '%';
    highlightCurrentThumb();
  }

  // ---------- Undo / redo history ----------
  // history[histIndex] always mirrors the current editor state. commit() records
  // a new state after a change; undo/redo step through. Snapshots clone the
  // mutable bits (annotations/rotations/crops) and reference the loaded document
  // (which only changes on crop/merge, so those steps reload on undo).
  const HISTORY_CAP = 60;
  let history = [];
  let histIndex = -1;
  let textCommitTimer = null;

  function cloneMap(obj) {
    const out = {};
    for (const k in obj) out[k] = obj[k] && typeof obj[k] === 'object' ? { ...obj[k] } : obj[k];
    return out;
  }
  function snapshot() {
    return {
      annotations: state.annotations.map(a => ({ ...a })),
      pageRotations: { ...state.pageRotations },
      pageCrops: cloneMap(state.pageCrops),
      loaded: state.loaded,
      currentPage: state.currentPage
    };
  }
  function resetHistory() {
    history = [snapshot()];
    histIndex = 0;
    updateUndoButtons();
  }
  function commit() {
    clearTimeout(textCommitTimer); textCommitTimer = null;
    if (histIndex < history.length - 1) history = history.slice(0, histIndex + 1); // drop redo tail
    history.push(snapshot());
    if (history.length > HISTORY_CAP) history.shift();
    histIndex = history.length - 1;
    updateUndoButtons();
  }
  function commitTextDebounced() {
    clearTimeout(textCommitTimer);
    textCommitTimer = setTimeout(commit, 500);
  }
  async function restore(snap) {
    const reload = snap.loaded !== state.loaded;
    state.annotations = snap.annotations.map(a => ({ ...a }));
    state.pageRotations = { ...snap.pageRotations };
    state.pageCrops = cloneMap(snap.pageCrops);
    state.loaded = snap.loaded;
    state.selectedAnnId = null;
    if (reload) { await openPdfjs(); await renderThumbs(); }
    state.currentPage = Math.min(snap.currentPage, state.numPages - 1);
    await renderPage();
    showInspector(state.currentTool);
    updateUndoButtons();
  }
  async function undo() {
    clearTimeout(textCommitTimer); textCommitTimer = null;
    if (histIndex <= 0) return;
    histIndex--;
    await restore(history[histIndex]);
  }
  async function redo() {
    if (histIndex >= history.length - 1) return;
    histIndex++;
    await restore(history[histIndex]);
  }
  function updateUndoButtons() {
    if (undoBtn) undoBtn.disabled = histIndex <= 0;
    if (redoBtn) redoBtn.disabled = histIndex >= history.length - 1;
  }
  if (undoBtn) undoBtn.onclick = undo;
  if (redoBtn) redoBtn.onclick = redo;

  // ---------- Annotation overlay ----------
  function pageAnns() {
    return state.annotations.filter(a => a.pageIndex === state.currentPage);
  }

  function annRect(a) {
    // Screen rectangle from PDF corners — robust under page rotation.
    const tl = toView(a.x, a.yTop);
    const br = toView(a.x + a.w, a.yTop - a.h);
    return {
      left: Math.min(tl.x, br.x),
      top: Math.min(tl.y, br.y),
      width: Math.abs(br.x - tl.x),
      height: Math.abs(br.y - tl.y)
    };
  }

  function renderOverlay() {
    annLayer.innerHTML = '';
    pageAnns().forEach(a => annLayer.appendChild(buildAnnEl(a)));
    const crop = state.pageCrops[state.currentPage];
    if (crop && state.currentTool === 'crop') annLayer.appendChild(buildCropEl(crop));
    updateActionBar();
  }

  // ---------- Finishing bar ----------
  function updateActionBar() {
    if (!state.loaded) return;
    const counts = { text: 0, signature: 0, redact: 0, comment: 0 };
    for (const a of state.annotations) counts[a.type] = (counts[a.type] || 0) + 1;
    const rotated = Object.values(state.pageRotations).filter(d => d % 360 !== 0).length;
    const cropped = Object.values(state.pageCrops).filter(Boolean).length;
    const parts = [];
    if (counts.text) parts.push(`<strong>${counts.text}</strong> text`);
    if (counts.signature) parts.push(`<strong>${counts.signature}</strong> signature${counts.signature > 1 ? 's' : ''}`);
    if (counts.redact) parts.push(`<strong>${counts.redact}</strong> redaction${counts.redact > 1 ? 's' : ''}`);
    if (counts.comment) parts.push(`<strong>${counts.comment}</strong> comment${counts.comment > 1 ? 's' : ''}`);
    if (cropped) parts.push(`<strong>${cropped}</strong> cropped page${cropped > 1 ? 's' : ''}`);
    if (rotated) parts.push(`<strong>${rotated}</strong> rotated page${rotated > 1 ? 's' : ''}`);
    vaSummary.innerHTML = parts.length
      ? parts.join(' · ') + ' — ready to save'
      : 'No changes yet — saves a copy of your PDF';
  }

  applyBtn.onclick = async () => {
    if (!state.loaded) return;
    PDFUtils.setStatus('Saving…');
    const res = await saveBytes(() => currentBytes(), `${PDFEngine.stripExt(state.loaded.name)}_edited.pdf`);
    if (res === 'saved') PDFUtils.setStatus('Saved your edited PDF.', 'success');
    else if (res === 'cancelled') PDFUtils.setStatus('');
    else PDFUtils.setStatus('Could not save the file.', 'error');
  };

  // ---------- Saving (choose location where supported) ----------
  const canPickFile = () => typeof window.showSaveFilePicker === 'function' && window.isSecureContext;
  const canPickDir = () => typeof window.showDirectoryPicker === 'function' && window.isSecureContext;

  async function resolveBytes(produce) {
    return typeof produce === 'function' ? await produce() : produce;
  }

  // Save a single PDF. On Chrome/Edge a native Save dialog lets the user pick
  // the folder + name; everywhere else (Safari, Firefox, iOS, Android) it falls
  // back to a normal download. `produce` is bytes or an async producer.
  // The picker opens BEFORE any heavy work to keep the user gesture valid.
  // Returns 'saved' | 'cancelled' | 'error'.
  async function saveBytes(produce, filename) {
    if (canPickFile()) {
      let handle;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }]
        });
      } catch (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
        handle = null; // not usable here — fall back to download
      }
      if (handle) {
        try {
          const bytes = await resolveBytes(produce);
          const w = await handle.createWritable();
          await w.write(new Blob([bytes], { type: 'application/pdf' }));
          await w.close();
          return 'saved';
        } catch (e) { console.error(e); return 'error'; }
      }
    }
    try {
      const bytes = await resolveBytes(produce);
      PDFUtils.download(new Blob([bytes], { type: 'application/pdf' }), filename);
      return 'saved';
    } catch (e) { console.error(e); return 'error'; }
  }

  // Save many files. On Chrome/Edge a directory picker writes them all to one
  // chosen folder; elsewhere each is downloaded individually. `produceItems` is
  // an async function returning [{ name, blob }]. Returns count saved (0 if cancelled).
  async function saveMany(produceItems) {
    if (canPickDir()) {
      let dir;
      try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); }
      catch (e) { if (e && e.name === 'AbortError') return 0; dir = null; }
      if (dir) {
        const items = await produceItems();
        for (const it of items) {
          const fh = await dir.getFileHandle(it.name, { create: true });
          const w = await fh.createWritable();
          await w.write(it.blob);
          await w.close();
        }
        return items.length;
      }
    }
    const items = await produceItems();
    for (const it of items) { PDFUtils.download(it.blob, it.name); await wait(120); }
    return items.length;
  }

  function buildAnnEl(a) {
    const el = document.createElement('div');
    el.className = 'ann ann-' + a.type + (a.id === state.selectedAnnId ? ' selected' : '');
    el.dataset.id = a.id;

    if (a.type === 'text') {
      const tl = toView(a.x, a.yTop);
      el.style.left = tl.x + 'px';
      el.style.top = tl.y + 'px';
      el.style.color = a.color;
      el.style.fontSize = (a.size * state.scale) + 'px';
      const fam = PDFEngine.FONT_FAMILIES[a.font] || PDFEngine.FONT_FAMILIES.arial;
      el.style.fontFamily = fam.css;
      el.style.fontWeight = a.bold ? '700' : '400';
      el.style.fontStyle = a.italic ? 'italic' : 'normal';
      el.style.textDecoration = a.underline ? 'underline' : 'none';
      if (a.bg) {
        el.style.background = a.bg;
        // Fixed cover (editing existing text): keep covering the original run
        // even when the replacement text is shorter or empty.
        if (a.bgW != null) {
          el.style.minWidth = (a.bgW * state.scale) + 'px';
          el.style.minHeight = (a.bgH * state.scale) + 'px';
        }
      }

      const edit = document.createElement('div');
      edit.className = 'ann-text-edit';
      edit.contentEditable = 'true';
      edit.spellcheck = false;
      edit.innerText = a.text;
      edit.addEventListener('input', () => {
        a.text = edit.innerText;
        // keep PDF-space size in sync with rendered box
        a.w = edit.offsetWidth / state.scale;
        a.h = edit.offsetHeight / state.scale;
        commitTextDebounced();
      });
      edit.addEventListener('focus', () => selectAnn(a.id, false));
      edit.addEventListener('pointerdown', e => e.stopPropagation());
      el.appendChild(edit);

      addMoveHandle(el, a, () => toView(a.x, a.yTop), (vx, vy) => {
        const p = toPdf(vx, vy); a.x = p.x; a.yTop = p.y;
      });
    } else if (a.type === 'comment') {
      const tl = toView(a.x, a.yTop);
      el.style.left = tl.x + 'px';
      el.style.top = tl.y + 'px';
      el.title = a.text || 'Comment';
      el.innerHTML = `
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-5 4V5a1 1 0 0 1 1-1Z" fill="#ffcf33" stroke="#a9820a" stroke-width="1.2" stroke-linejoin="round"/>
          <path d="M8 9h8M8 12h5" stroke="#a9820a" stroke-width="1.2" stroke-linecap="round"/>
        </svg>`;
      // drag the marker by its body
      el.addEventListener('pointerdown', e => {
        beginDrag(e, a, () => {
          const v = toView(a.x, a.yTop); return { left: v.x, top: v.y };
        }, (left, top) => { const p = toPdf(left, top); a.x = p.x; a.yTop = p.y; });
      });
    } else {
      const r = annRect(a);
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.width = r.width + 'px';
      el.style.height = r.height + 'px';

      if (a.type === 'signature') {
        const img = document.createElement('img');
        img.src = a.dataUrl;
        img.draggable = false;
        el.appendChild(img);
      } else if (a.type === 'redact') {
        el.title = 'Redaction (covers content visually)';
      }

      // whole-body drag
      el.addEventListener('pointerdown', e => {
        if (e.target.classList.contains('ann-resize')) return;
        beginDrag(e, a, () => annRect(a), (left, top) => {
          const p = toPdf(left, top);
          a.x = p.x; a.yTop = p.y;
        });
      });
      addResizeHandle(el, a);
    }

    el.addEventListener('pointerdown', () => selectAnn(a.id, false));
    return el;
  }

  function addMoveHandle(el, a, getOrigin, setFromView) {
    const h = document.createElement('div');
    h.className = 'ann-move';
    h.title = 'Drag to move';
    h.addEventListener('pointerdown', e => {
      e.stopPropagation();
      const start = stagePoint(e);
      const origin = getOrigin();
      const offX = start.x - origin.x, offY = start.y - origin.y;
      let moved = false;
      const move = ev => {
        moved = true;
        const p = stagePoint(ev);
        setFromView(p.x - offX, p.y - offY);
        const o = getOrigin();
        el.style.left = o.x + 'px';
        el.style.top = o.y + 'px';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (moved) commit();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    el.appendChild(h);
  }

  function beginDrag(e, a, getRect, apply) {
    e.stopPropagation();
    const start = stagePoint(e);
    const r0 = getRect();
    const offX = start.x - r0.left, offY = start.y - r0.top;
    const el = annLayer.querySelector(`[data-id="${a.id}"]`);
    let moved = false;
    const move = ev => {
      moved = true;
      const p = stagePoint(ev);
      apply(p.x - offX, p.y - offY);
      const r = getRect();
      if (el) { el.style.left = r.left + 'px'; el.style.top = r.top + 'px'; }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) commit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function addResizeHandle(el, a) {
    const h = document.createElement('div');
    h.className = 'ann-resize';
    h.title = 'Drag to resize';
    h.addEventListener('pointerdown', e => {
      e.stopPropagation();
      const start = stagePoint(e);
      const w0 = a.w, h0 = a.h;
      const aspect = w0 / h0;
      let moved = false;
      const move = ev => {
        moved = true;
        const p = stagePoint(ev);
        let dw = (p.x - start.x) / state.scale;
        a.w = Math.max(8, w0 + dw);
        a.h = a.type === 'signature' ? a.w / aspect : Math.max(8, h0 + (p.y - start.y) / state.scale);
        const r = annRect(a);
        el.style.width = r.width + 'px';
        el.style.height = r.height + 'px';
        el.style.left = r.left + 'px';
        el.style.top = r.top + 'px';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (moved) commit();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    el.appendChild(h);
  }

  function selectAnn(id, rerender = true) {
    state.selectedAnnId = id;
    if (rerender) renderOverlay();
    else {
      annLayer.querySelectorAll('.ann').forEach(n =>
        n.classList.toggle('selected', n.dataset.id === id));
    }
    const a = state.annotations.find(x => x.id === id);
    if (a) showInspector(a.type, a);
  }

  function deleteAnn(id) {
    state.annotations = state.annotations.filter(a => a.id !== id);
    if (state.selectedAnnId === id) state.selectedAnnId = null;
    renderOverlay();
    showInspector(state.currentTool);
    commit();
  }

  document.addEventListener('keydown', e => {
    if (!state.loaded) return;
    const active = document.activeElement;
    const tag = active && active.tagName;
    const inField = active && (active.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');

    // Undo / redo — leave native undo to text fields when one is focused
    if ((e.ctrlKey || e.metaKey) && !inField) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedAnnId) {
      // don't hijack delete/backspace while typing in any field
      if (inField) return;
      e.preventDefault();
      deleteAnn(state.selectedAnnId);
    }
  });

  // ---------- Stage interactions (place text / signature / redact) ----------
  annLayer.addEventListener('pointerdown', e => {
    if (e.target !== annLayer) return; // clicked empty space
    const p = stagePoint(e);

    if (state.currentTool === 'text') {
      createText(p.x, p.y, { size: 16, color: '#111111' });
    } else if (state.currentTool === 'sign') {
      if (!state.pendingSignature) {
        PDFUtils.setStatus('Create a signature first (draw or upload).', 'error');
        return;
      }
      placeSignature(p.x, p.y);
    } else if (state.currentTool === 'redact') {
      startDrawRedact(e, p);
    } else if (state.currentTool === 'comment') {
      createComment(p.x, p.y);
    } else if (state.currentTool === 'crop') {
      startDrawCrop(e, p);
    } else if (state.currentTool === 'edittext') {
      // deselect and bring the editable-text outlines back so another run can be picked
      state.selectedAnnId = null;
      renderOverlay();
      if (state.pdfjsDoc) state.pdfjsDoc.getPage(state.currentPage + 1).then(renderTextLayer);
    } else {
      // select tool: clicking empty deselects
      state.selectedAnnId = null;
      renderOverlay();
    }
  });

  function createText(viewX, viewY, opts) {
    const p = toPdf(viewX, viewY);
    const a = {
      id: uid(), type: 'text', pageIndex: state.currentPage,
      x: p.x, yTop: p.y, w: 140, h: (opts.size || 16) * 1.4,
      text: '', size: opts.size || 16, color: opts.color || '#111111', bg: opts.bg || null,
      font: opts.font || 'arial', bold: !!opts.bold, italic: !!opts.italic, underline: !!opts.underline
    };
    state.annotations.push(a);
    selectAnn(a.id);
    commit();
    requestAnimationFrame(() => {
      const node = annLayer.querySelector(`[data-id="${a.id}"] .ann-text-edit`);
      if (node) node.focus();
    });
  }

  function placeSignature(viewX, viewY) {
    const sig = state.pendingSignature;
    const p = toPdf(viewX, viewY);
    const w = 160, h = w / sig.aspect;
    const a = {
      id: uid(), type: 'signature', pageIndex: state.currentPage,
      x: p.x, yTop: p.y, w, h,
      imageBytes: sig.imageBytes, mime: sig.mime, dataUrl: sig.dataUrl
    };
    state.annotations.push(a);
    selectAnn(a.id);
    commit();
  }

  function startDrawRedact(e, startPt) {
    const ghost = document.createElement('div');
    ghost.className = 'ann ann-redact';
    ghost.style.left = startPt.x + 'px';
    ghost.style.top = startPt.y + 'px';
    annLayer.appendChild(ghost);
    const move = ev => {
      const p = stagePoint(ev);
      ghost.style.left = Math.min(p.x, startPt.x) + 'px';
      ghost.style.top = Math.min(p.y, startPt.y) + 'px';
      ghost.style.width = Math.abs(p.x - startPt.x) + 'px';
      ghost.style.height = Math.abs(p.y - startPt.y) + 'px';
    };
    const up = ev => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const p = stagePoint(ev);
      const left = Math.min(p.x, startPt.x), top = Math.min(p.y, startPt.y);
      const wPx = Math.abs(p.x - startPt.x), hPx = Math.abs(p.y - startPt.y);
      ghost.remove();
      if (wPx < 6 || hPx < 6) { renderOverlay(); return; }
      const tl = toPdf(left, top);
      const a = {
        id: uid(), type: 'redact', pageIndex: state.currentPage,
        x: tl.x, yTop: tl.y, w: wPx / state.scale, h: hPx / state.scale
      };
      state.annotations.push(a);
      selectAnn(a.id);
      commit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---------- Comment (sticky note) ----------
  function createComment(viewX, viewY) {
    const p = toPdf(viewX, viewY);
    const a = {
      id: uid(), type: 'comment', pageIndex: state.currentPage,
      x: p.x, yTop: p.y, w: 22, h: 22, text: ''
    };
    state.annotations.push(a);
    selectAnn(a.id);
    commit();
  }

  // ---------- Crop ----------
  function startDrawCrop(e, startPt) {
    const ghost = document.createElement('div');
    ghost.className = 'crop-rect';
    ghost.style.left = startPt.x + 'px';
    ghost.style.top = startPt.y + 'px';
    annLayer.appendChild(ghost);
    const move = ev => {
      const p = stagePoint(ev);
      ghost.style.left = Math.min(p.x, startPt.x) + 'px';
      ghost.style.top = Math.min(p.y, startPt.y) + 'px';
      ghost.style.width = Math.abs(p.x - startPt.x) + 'px';
      ghost.style.height = Math.abs(p.y - startPt.y) + 'px';
    };
    const up = ev => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const p = stagePoint(ev);
      const left = Math.min(p.x, startPt.x), top = Math.min(p.y, startPt.y);
      const wPx = Math.abs(p.x - startPt.x), hPx = Math.abs(p.y - startPt.y);
      ghost.remove();
      if (wPx < 10 || hPx < 10) { renderOverlay(); return; }
      const tl = toPdf(left, top);
      const br = toPdf(left + wPx, top + hPx);
      state.pageCrops[state.currentPage] = {
        x: Math.min(tl.x, br.x), yTop: Math.max(tl.y, br.y),
        w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y)
      };
      renderOverlay();
      showInspector('crop');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Crop box overlay for the current page (dim outside, draggable + resizable).
  function buildCropEl(c) {
    const el = document.createElement('div');
    el.className = 'crop-rect crop-active';
    const place = () => {
      const r = annRect({ x: c.x, yTop: c.yTop, w: c.w, h: c.h });
      el.style.left = r.left + 'px'; el.style.top = r.top + 'px';
      el.style.width = r.width + 'px'; el.style.height = r.height + 'px';
    };
    place();
    // drag to move
    el.addEventListener('pointerdown', ev => {
      if (ev.target.classList.contains('ann-resize')) return;
      ev.stopPropagation();
      const start = stagePoint(ev);
      const r0 = annRect({ x: c.x, yTop: c.yTop, w: c.w, h: c.h });
      const offX = start.x - r0.left, offY = start.y - r0.top;
      const move = e2 => {
        const pt = stagePoint(e2);
        const ntl = toPdf(pt.x - offX, pt.y - offY);
        c.x = ntl.x; c.yTop = ntl.y;
        place();
      };
      const upp = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', upp); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', upp);
    });
    // resize handle
    const h = document.createElement('div');
    h.className = 'ann-resize';
    h.addEventListener('pointerdown', ev => {
      ev.stopPropagation();
      const start = stagePoint(ev);
      const w0 = c.w, h0 = c.h;
      const move = e2 => {
        const pt = stagePoint(e2);
        c.w = Math.max(16, w0 + (pt.x - start.x) / state.scale);
        c.h = Math.max(16, h0 + (pt.y - start.y) / state.scale);
        place();
      };
      const upp = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', upp); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', upp);
    });
    el.appendChild(h);
    return el;
  }

  // ---------- Edit-existing-text layer ----------
  async function renderTextLayer(page) {
    textLayer.innerHTML = '';
    textLayer.style.display = 'block';
    let content;
    try { content = await page.getTextContent(); }
    catch { return; }
    const styles = content.styles || {};
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const tr = item.transform; // [a,b,c,d,e,f] in PDF user space
      const size = Math.hypot(tr[2], tr[3]) || tr[3] || 12;
      const ascent = size * 0.8;
      const topLeft = toView(tr[4], tr[5] + ascent);
      const box = document.createElement('div');
      box.className = 'text-run';
      box.style.left = topLeft.x + 'px';
      box.style.top = topLeft.y + 'px';
      box.style.width = (item.width * state.scale) + 'px';
      box.style.height = (size * 1.2 * state.scale) + 'px';
      box.title = 'Click to edit this text';
      box.addEventListener('pointerdown', e => {
        e.stopPropagation();
        editExistingRun(item, size, detectFont(item, styles, page));
        clearTextLayer(); // hide ALL run boxes so editing isn't intercepted by neighbours
      });
      textLayer.appendChild(box);
    }
  }

  // Best-effort match of an existing text run to one of our 5 font families.
  // `detected` is false when we have no reliable signal — the user is then asked to pick.
  function detectFont(item, styles, page) {
    let name = '';
    try {
      const f = page.commonObjs.get(item.fontName);
      name = (f && f.name) || '';
    } catch { /* font not resolved */ }
    const style = styles[item.fontName] || {};
    const fam = (style.fontFamily || '').toLowerCase();
    const ln = (name || '').toLowerCase();
    const bold = /bold|black|semibold|heavy|[-_ ]bd/.test(ln);
    const italic = /italic|oblique/.test(ln);
    let key = null;
    if (/calibri|carlito/.test(ln)) key = 'calibri';
    else if (/georgia|gelasio/.test(ln)) key = 'georgia';
    else if (/courier|mono|consolas/.test(ln) || fam.includes('mono')) key = 'courier';
    else if (/times|cambria|garamond|book antiqua|minion|roman/.test(ln)) key = 'times';
    else if (/arial|helvetica|calibri|verdana|tahoma|segoe/.test(ln)) key = 'arial';
    else if (fam.includes('serif') && !fam.includes('sans')) key = 'times';
    else if (fam.includes('sans')) key = 'arial';
    // key stays null when nothing matched -> ask the user
    return { font: key, bold, italic, detected: key !== null };
  }

  function editExistingRun(item, size, detected) {
    const tr = item.transform;
    const baseline = tr[5];               // PDF baseline (bottom-left origin)
    // yTop is the top anchor; baked baseline = yTop - size, so this lands the
    // replacement on the ORIGINAL baseline.
    const yTop = baseline + size;
    const coverW = item.width;
    const coverH = size * 1.3;            // covers ascenders + descenders generously
    const a = {
      id: uid(), type: 'text', pageIndex: state.currentPage,
      x: tr[4], yTop,
      w: coverW, h: coverH,
      bgW: coverW, bgH: coverH,            // FIXED cover sized to the original run
      text: item.str, size: Math.round(size),
      color: '#111111', bg: '#ffffff',   // white cover hides the original glyphs
      font: (detected && detected.font) || '',   // '' => undetected, user must pick
      bold: !!(detected && detected.bold), italic: !!(detected && detected.italic), underline: false
    };
    state.annotations.push(a);
    selectAnn(a.id);
    commit();
    requestAnimationFrame(() => {
      const node = annLayer.querySelector(`[data-id="${a.id}"] .ann-text-edit`);
      if (node) {
        node.focus();
        const sel = window.getSelection(); const range = document.createRange();
        range.selectNodeContents(node); sel.removeAllRanges(); sel.addRange(range);
      }
    });
  }

  function clearTextLayer() {
    textLayer.innerHTML = '';
    textLayer.style.display = 'none';
  }

  // ---------- Thumbnail rail ----------
  async function renderThumbs() {
    pagesRail.innerHTML = '';
    const thumbs = await PDFEngine.renderThumbnails(state.loaded, { scale: 0.2 });
    thumbs.forEach(t => {
      const item = document.createElement('div');
      item.className = 'pg-thumb';
      item.dataset.page = t.pageIndex;
      item.innerHTML = `<img src="${t.dataUrl}" alt="Page ${t.pageIndex + 1}" /><span class="pg-num">${t.pageIndex + 1}</span>`;
      item.addEventListener('click', () => {
        if (PAGE_OP_TOOLS.includes(state.currentTool)) {
          togglePageSelect(t.pageIndex);
        } else {
          state.currentPage = t.pageIndex;
          state.selectedAnnId = null;
          renderPage();
        }
      });
      pagesRail.appendChild(item);
    });
    highlightCurrentThumb();
  }

  function highlightCurrentThumb() {
    pagesRail.querySelectorAll('.pg-thumb').forEach(n => {
      const idx = Number(n.dataset.page);
      n.classList.toggle('current', idx === state.currentPage);
      n.classList.toggle('selected', state.selectedPages.has(idx));
    });
  }

  function togglePageSelect(idx) {
    if (state.selectedPages.has(idx)) state.selectedPages.delete(idx);
    else state.selectedPages.add(idx);
    highlightCurrentThumb();
    if (PAGE_OP_TOOLS.includes(state.currentTool)) showInspector(state.currentTool);
  }

  // ---------- Navigation & zoom ----------
  $('#nav-prev').onclick = () => { if (state.currentPage > 0) { state.currentPage--; state.selectedAnnId = null; renderPage(); } };
  $('#nav-next').onclick = () => { if (state.currentPage < state.numPages - 1) { state.currentPage++; state.selectedAnnId = null; renderPage(); } };
  navPage.onchange = () => {
    const n = Math.max(1, Math.min(state.numPages, Number(navPage.value) || 1));
    state.currentPage = n - 1; state.selectedAnnId = null; renderPage();
  };
  $('#zoom-in').onclick = () => { state.scale = Math.min(4, state.scale + 0.25); renderPage(); };
  $('#zoom-out').onclick = () => { state.scale = Math.max(0.25, state.scale - 0.25); renderPage(); };
  $('#zoom-fit').onclick = async () => {
    if (!state.pdfjsDoc) return;
    const page = await state.pdfjsDoc.getPage(state.currentPage + 1);
    const vp = page.getViewport({ scale: 1 });
    const avail = $('#viewer-scroll').clientWidth - 64;
    state.scale = Math.max(0.25, Math.min(4, avail / vp.width));
    renderPage();
  };

  // ---------- Tool switching ----------
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      if (tool === 'open') { fileInput.click(); return; }
      if (tool === 'add') { addInput.click(); return; }
      if (!state.loaded) return;
      setTool(tool);
    });
  });

  function setTool(tool) {
    state.currentTool = tool;
    document.querySelectorAll('.tool-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === tool));
    stage.dataset.tool = tool;
    if (!PAGE_OP_TOOLS.includes(tool)) { state.selectedPages.clear(); highlightCurrentThumb(); }
    if (state.pdfjsDoc) {
      if (tool === 'edittext') state.pdfjsDoc.getPage(state.currentPage + 1).then(renderTextLayer);
      else clearTextLayer();
    }
    if (state.viewport) renderOverlay(); // show/hide the crop box when entering/leaving Crop
    showInspector(tool);
  }

  // ---------- Merge ----------
  addInput.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    PDFUtils.setStatus('Merging…');
    try {
      const baked = await currentLoaded();          // bake current edits first
      const additional = await PDFEngine.loadPdf(file);
      const merged = await PDFEngine.merge([baked, additional]);
      state.loaded = await PDFEngine.loadPdf(new File([merged], state.loaded.name, { type: 'application/pdf' }));
      state.annotations = [];
      state.pageRotations = {};
      state.pageCrops = {};
      state.selectedPages.clear();
      state.selectedAnnId = null;
      await openPdfjs();
      vtFile.textContent = `${state.loaded.name} · ${PDFUtils.formatBytes(state.loaded.size)}`;
      await renderThumbs();
      await renderPage();
      commit();
      PDFUtils.setStatus(`Added ${file.name}.`, 'success');
    } catch (err) {
      console.error(err);
      PDFUtils.setStatus('Could not merge that file.', 'error');
    }
    addInput.value = '';
  });

  // ---------- Bake helpers ----------
  async function currentBytes() {
    return PDFEngine.applyAnnotations(state.loaded, state.annotations, state.pageRotations, state.pageCrops);
  }
  async function currentLoaded() {
    const bytes = await currentBytes();
    const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    return { doc, bytes, name: state.loaded.name, size: bytes.length };
  }

  // ---------- Inspector ----------
  function showInspector(tool, ann) {
    inspectorBody.innerHTML = '';

    if (ann && ann.type === 'text') return inspText(ann);
    if (ann && ann.type === 'signature') return inspSelectedBox(ann, 'Signature', 'Drag to move, drag the corner to resize.');
    if (ann && ann.type === 'redact') return inspSelectedBox(ann, 'Redaction', 'Covers the content with an opaque box. Note: the underlying text is hidden, not deleted from the file.');
    if (ann && ann.type === 'comment') return inspComment(ann);

    if (tool === 'select') {
      inspectorTitle.textContent = 'Select / Move';
      inspectorHint.textContent = 'Click any text, signature or redaction on the page to move, resize or delete it.';
      return;
    }
    if (tool === 'text') {
      inspectorTitle.textContent = 'Add text';
      inspectorHint.textContent = 'Click anywhere on the page to drop a text box, then type. Drag the grip to move it.';
      return;
    }
    if (tool === 'edittext') {
      inspectorTitle.textContent = 'Edit existing text';
      inspectorHint.textContent = 'Highlighted boxes mark editable text. Click one to change the words, or clear it to remove. Originals are covered with white.';
      return;
    }
    if (tool === 'sign') return inspSign();
    if (tool === 'redact') {
      inspectorTitle.textContent = 'Redact';
      inspectorHint.textContent = 'Drag a rectangle over anything you want to black out. Covers content visually — underlying text stays in the file but hidden.';
      return;
    }
    if (tool === 'comment') {
      inspectorTitle.textContent = 'Comment';
      inspectorHint.textContent = 'Click anywhere on the page to drop a sticky note, then type your comment. It is saved as a real PDF comment.';
      return;
    }
    if (tool === 'crop') return inspCrop();
    if (tool === 'rotate') return inspRotate();
    if (tool === 'split') return inspSplit();
    if (tool === 'delete') return inspDelete();
    if (tool === 'compress') return inspCompress();
    if (tool === 'toimage') return inspToImage();
    if (tool === 'download') return inspDownload();
  }

  function inspText(a) {
    inspectorTitle.textContent = a.bg ? 'Edit text' : 'Text';
    const undetected = !a.font;
    inspectorHint.textContent = 'Type to edit. Drag the grip to move.';
    const fontOpts = Object.entries(PDFEngine.FONT_FAMILIES)
      .map(([k, f]) => `<option value="${k}" ${a.font === k ? 'selected' : ''}>${f.label}</option>`).join('');
    const placeholder = undetected ? `<option value="" disabled selected>— Pick a font —</option>` : '';
    const notice = undetected
      ? `<p class="field-note" id="t-font-note">We couldn't detect the original font. Pick one of our available fonts to keep editing.</p>`
      : '';
    inspectorBody.innerHTML = `
      <div class="field"><label>Font</label>
        <select id="t-font" ${undetected ? 'class="needs-pick"' : ''}>${placeholder}${fontOpts}</select>
        ${notice}
      </div>
      <div class="field-row">
        <div class="field"><label>Size</label><input type="number" id="t-size" value="${a.size}" min="4" max="120" /></div>
        <div class="field"><label>Color</label><input type="color" id="t-color" value="${a.color}" /></div>
      </div>
      <div class="field">
        <label>Style</label>
        <div class="style-toggles">
          <button type="button" class="sty-btn ${a.bold ? 'active' : ''}" id="t-bold" style="font-weight:700;">B</button>
          <button type="button" class="sty-btn ${a.italic ? 'active' : ''}" id="t-italic" style="font-style:italic;">I</button>
          <button type="button" class="sty-btn ${a.underline ? 'active' : ''}" id="t-underline" style="text-decoration:underline;">U</button>
        </div>
      </div>
      <div class="field">
        <label>Insert symbol</label>
        <div class="symbol-pad" id="t-symbols">
          ${SYMBOLS.map(s => `<button type="button" class="sym-btn" data-sym="${s}">${s}</button>`).join('')}
        </div>
      </div>
      <label class="check"><input type="checkbox" id="t-bg" ${a.bg ? 'checked' : ''} /> White background (hide content underneath)</label>
      <button class="btn btn-ghost btn-block" id="t-del" type="button" style="margin-top:12px;">Delete text</button>
    `;
    // symbol palette — preventDefault on mousedown keeps the caret in the text box
    $('#t-symbols').querySelectorAll('.sym-btn').forEach(btn => {
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => insertSymbol(a, btn.dataset.sym));
    });
    const apply = () => { renderOverlay(); reselect(a.id); measureText(a); };
    $('#t-font').onchange = () => {
      a.font = $('#t-font').value;
      renderOverlay(); reselect(a.id); measureText(a);
      commit();
      showInspector('text', a); // refresh so the "pick a font" prompt clears
    };
    $('#t-size').oninput = () => { a.size = Number($('#t-size').value) || a.size; apply(); commitTextDebounced(); };
    $('#t-color').oninput = () => { a.color = $('#t-color').value; renderOverlay(); reselect(a.id); commitTextDebounced(); };
    $('#t-bold').onclick = () => { a.bold = !a.bold; $('#t-bold').classList.toggle('active', a.bold); apply(); commit(); };
    $('#t-italic').onclick = () => { a.italic = !a.italic; $('#t-italic').classList.toggle('active', a.italic); apply(); commit(); };
    $('#t-underline').onclick = () => { a.underline = !a.underline; $('#t-underline').classList.toggle('active', a.underline); renderOverlay(); reselect(a.id); commit(); };
    $('#t-bg').onchange = () => { a.bg = $('#t-bg').checked ? '#ffffff' : null; renderOverlay(); reselect(a.id); commit(); };
    $('#t-del').onclick = () => deleteAnn(a.id);
  }

  // Common math / special symbols for the text tool.
  const SYMBOLS = ['×','÷','±','≤','≥','≠','≈','√','π','∑','∫','∞','∂','∆','µ','°','²','³','½','¼','¾','·','→','←','↔','•','§','€','£','¥','©','®','™','α','β','γ','θ','λ','Ω'];

  function insertSymbol(a, sym) {
    const node = annLayer.querySelector(`[data-id="${a.id}"] .ann-text-edit`);
    if (!node) return;
    if (document.activeElement === node && document.execCommand) {
      document.execCommand('insertText', false, sym);
    } else {
      node.textContent = (node.textContent || '') + sym;
    }
    a.text = node.innerText;
    measureText(a);
    commitTextDebounced();
  }

  function reselect(id) {
    annLayer.querySelectorAll('.ann').forEach(n => n.classList.toggle('selected', n.dataset.id === id));
  }

  function inspComment(a) {
    inspectorTitle.textContent = 'Comment';
    inspectorHint.textContent = 'This is saved as a real PDF sticky note. Drag the marker to move it.';
    inspectorBody.innerHTML = `
      <div class="field">
        <label>Note</label>
        <textarea id="cm-text" rows="5" placeholder="Type your comment…">${PDFUtils.escapeHTML(a.text || '')}</textarea>
      </div>
      <button class="btn btn-ghost btn-block" id="cm-del" type="button">Delete comment</button>
    `;
    const ta = $('#cm-text');
    ta.oninput = () => {
      a.text = ta.value;
      const el = annLayer.querySelector(`[data-id="${a.id}"]`);
      if (el) el.title = a.text || 'Comment';
      commitTextDebounced();
    };
    ta.focus();
    $('#cm-del').onclick = () => deleteAnn(a.id);
  }

  function inspCrop() {
    const has = !!state.pageCrops[state.currentPage];
    inspectorTitle.textContent = 'Crop page';
    inspectorHint.textContent = has
      ? 'Drag the box to move it, the corner to resize. Click Crop to apply — the page becomes that area and you keep editing.'
      : 'Drag a rectangle on the page to set the crop area. Only what is inside is kept.';
    inspectorBody.innerHTML = `
      <label class="check"><input type="checkbox" id="crop-all" /> Crop all pages to this area</label>
      <button class="btn btn-primary btn-block" id="crop-apply" type="button" style="margin-top:12px;" ${has ? '' : 'disabled style="opacity:.5"'}>Crop</button>
      <button class="btn btn-ghost btn-block" id="crop-reset" type="button" style="margin-top:8px;" ${has ? '' : 'disabled style="opacity:.5"'}>Clear selection</button>
    `;
    const applyBtnEl = $('#crop-apply');
    if (applyBtnEl) applyBtnEl.onclick = () => applyCropNow($('#crop-all').checked);
    const reset = $('#crop-reset');
    if (reset) reset.onclick = () => {
      delete state.pageCrops[state.currentPage];
      renderOverlay();
      showInspector('crop');
    };
  }

  // Apply the crop into the document NOW: the cropped region becomes the page,
  // the preview reloads, and editing continues. Pending text/signatures/etc.
  // stay live (their coordinates remain valid within the new crop box).
  async function applyCropNow(allPages) {
    const cur = state.pageCrops[state.currentPage];
    if (!cur) { PDFUtils.setStatus('Draw a crop area first.', 'error'); return; }
    if (allPages) for (let i = 0; i < state.numPages; i++) state.pageCrops[i] = { ...cur };
    PDFUtils.setStatus('Cropping…');
    try {
      // bake the crop only (no annotations/rotations) so those stay editable
      const bytes = await PDFEngine.applyAnnotations(state.loaded, [], {}, state.pageCrops);
      state.loaded = await PDFEngine.loadPdf(new File([bytes], state.loaded.name, { type: 'application/pdf' }));
      state.pageCrops = {};
      await openPdfjs();
      vtFile.textContent = `${state.loaded.name} · ${PDFUtils.formatBytes(state.loaded.size)}`;
      await renderThumbs();
      await renderPage();
      setTool('select');
      commit();
      PDFUtils.setStatus('Page cropped — keep editing.', 'success');
    } catch (e) {
      console.error(e);
      PDFUtils.setStatus('Crop failed.', 'error');
    }
  }

  // Re-measure a text box after a style change that affects its size.
  function measureText(a) {
    const node = annLayer.querySelector(`[data-id="${a.id}"] .ann-text-edit`);
    if (node) { a.w = node.offsetWidth / state.scale; a.h = node.offsetHeight / state.scale; }
  }

  function inspSelectedBox(a, title, hint) {
    inspectorTitle.textContent = title;
    inspectorHint.textContent = hint;
    inspectorBody.innerHTML = `<button class="btn btn-ghost btn-block" id="b-del" type="button">Delete</button>`;
    $('#b-del').onclick = () => deleteAnn(a.id);
  }

  function inspSign() {
    inspectorTitle.textContent = 'Signature';
    inspectorHint.textContent = state.pendingSignature
      ? 'Click on the page to place your signature. Drag to move, drag the corner to resize.'
      : 'Draw or upload your signature, then click on the page to place it.';
    inspectorBody.innerHTML = `
      <div class="field">
        <label>Draw signature</label>
        <canvas id="sig-pad" class="sig-pad"></canvas>
        <div class="field-row" style="margin-top:6px;">
          <button class="btn btn-ghost" id="sig-clear" type="button" style="padding:6px 12px;font-size:13px;">Clear</button>
          <button class="btn btn-ghost" id="sig-upload-btn" type="button" style="padding:6px 12px;font-size:13px;">Upload image</button>
        </div>
      </div>
      <button class="btn btn-primary btn-block" id="sig-use" type="button">Use this signature</button>
      ${state.pendingSignature ? '<p class="hint" style="margin-top:10px;color:var(--accent)">✓ Ready — click on the page to place it.</p>' : ''}
    `;
    setupSigPad();
    $('#sig-clear').onclick = clearSig;
    $('#sig-upload-btn').onclick = () => sigInput.click();
    $('#sig-use').onclick = useSignature;
  }

  function inspRotate() {
    inspectorTitle.textContent = 'Rotate pages';
    inspectorHint.textContent = state.selectedPages.size
      ? `${state.selectedPages.size} page(s) selected in the rail.`
      : 'Rotates the current page. Select pages in the rail to rotate several.';
    inspectorBody.innerHTML = `
      <div class="field-row">
        <button class="btn btn-ghost" id="rot-left" type="button">↺ 90° left</button>
        <button class="btn btn-ghost" id="rot-right" type="button">↻ 90° right</button>
      </div>
      <button class="btn btn-ghost btn-block" id="rot-180" type="button" style="margin-top:8px;">180°</button>
      <p class="hint" style="margin-top:10px;">Rotation shows live and is included when you download.</p>
    `;
    const setRot = deg => {
      const targets = state.selectedPages.size ? Array.from(state.selectedPages) : [state.currentPage];
      targets.forEach(i => {
        state.pageRotations[i] = (((state.pageRotations[i] || 0) + deg) % 360 + 360) % 360;
      });
      renderPage();
      commit();
    };
    $('#rot-left').onclick = () => setRot(-90);
    $('#rot-right').onclick = () => setRot(90);
    $('#rot-180').onclick = () => setRot(180);
  }

  function inspSplit() {
    inspectorTitle.textContent = 'Split / Extract';
    inspectorHint.textContent = state.selectedPages.size
      ? `Will extract ${state.selectedPages.size} selected page(s).`
      : 'Select pages in the rail, or enter a range below.';
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
        pages = parseRange(rangeText, state.numPages);
        if (!pages.length) { PDFUtils.setStatus('Invalid range.', 'error'); return; }
      } else if (state.selectedPages.size) {
        pages = Array.from(state.selectedPages).sort((a, b) => a - b);
      } else { PDFUtils.setStatus('Select pages or enter a range.', 'error'); return; }
      PDFUtils.setStatus('Saving…');
      const res = await saveBytes(async () => {
        const src = await currentLoaded();
        const [result] = await PDFEngine.split(src, [pages]);
        return result.bytes;
      }, `${PDFEngine.stripExt(state.loaded.name)}_extracted.pdf`);
      if (res === 'saved') PDFUtils.setStatus('Pages extracted.', 'success');
      else if (res === 'cancelled') PDFUtils.setStatus('');
      else PDFUtils.setStatus('Extraction failed.', 'error');
    };
    $('#split-each').onclick = async () => {
      PDFUtils.setStatus(canPickDir() ? 'Choose a folder to save into…' : 'Splitting…');
      try {
        const n = await saveMany(async () => {
          PDFUtils.setStatus('Splitting…');
          const src = await currentLoaded();
          const ranges = Array.from({ length: state.numPages }, (_, i) => [i]);
          const results = await PDFEngine.split(src, ranges);
          return results.map(r => ({ name: r.name, blob: new Blob([r.bytes], { type: 'application/pdf' }) }));
        });
        PDFUtils.setStatus(n ? `${n} files saved.` : '', n ? 'success' : undefined);
      } catch (e) { console.error(e); PDFUtils.setStatus('Split failed.', 'error'); }
    };
  }

  function inspDelete() {
    inspectorTitle.textContent = 'Delete pages';
    inspectorHint.textContent = state.selectedPages.size
      ? `${state.selectedPages.size} page(s) will be removed.`
      : 'Select pages in the rail to delete.';
    inspectorBody.innerHTML = `
      <button class="btn btn-primary btn-block" id="del-apply" type="button" ${!state.selectedPages.size ? 'disabled style="opacity:.5"' : ''}>Delete selected & download</button>
    `;
    const btn = $('#del-apply');
    if (btn) btn.onclick = async () => {
      const keep = Array.from({ length: state.numPages }, (_, i) => i).filter(i => !state.selectedPages.has(i));
      if (!keep.length) { PDFUtils.setStatus('You must keep at least one page.', 'error'); return; }
      PDFUtils.setStatus('Saving…');
      const res = await saveBytes(async () => {
        const src = await currentLoaded();
        const [result] = await PDFEngine.split(src, [keep]);
        return result.bytes;
      }, `${PDFEngine.stripExt(state.loaded.name)}_edited.pdf`);
      if (res === 'saved') PDFUtils.setStatus('Done.', 'success');
      else if (res === 'cancelled') PDFUtils.setStatus('');
      else PDFUtils.setStatus('Delete failed.', 'error');
    };
  }

  function inspCompress() {
    inspectorTitle.textContent = 'Compress PDF';
    inspectorHint.textContent = 'Re-encode pages to reduce file size. Your edits are included.';
    inspectorBody.innerHTML = `
      <div class="field">
        <label>Compression level</label>
        <select id="comp-level">
          <option value="low">Low — best quality (~30% smaller)</option>
          <option value="medium" selected>Medium — balanced (~50% smaller)</option>
          <option value="high">High — smallest size</option>
        </select>
      </div>
      <button class="btn btn-primary btn-block" id="comp-apply" type="button">Apply changes &amp; compress</button>
    `;
    $('#comp-apply').onclick = async () => {
      const presets = { low: { quality: 0.85, dpi: 150 }, medium: { quality: 0.7, dpi: 120 }, high: { quality: 0.5, dpi: 96 } };
      const level = $('#comp-level').value;
      let savedPct = null;
      PDFUtils.setStatus('Choose where to save…');
      const res = await saveBytes(async () => {
        PDFUtils.setStatus('Compressing… this may take a moment.');
        const src = await currentLoaded();
        const out = await PDFEngine.compress(src, presets[level]);
        savedPct = ((1 - out.length / src.size) * 100).toFixed(0);
        return out;
      }, `${PDFEngine.stripExt(state.loaded.name)}_compressed.pdf`);
      if (res === 'saved') PDFUtils.setStatus(savedPct > 0 ? `Done — ${savedPct}% smaller.` : 'Done — file was already optimized.', 'success');
      else if (res === 'cancelled') PDFUtils.setStatus('');
      else PDFUtils.setStatus('Compression failed.', 'error');
    };
  }

  function inspToImage() {
    inspectorTitle.textContent = 'Export as images';
    inspectorHint.textContent = 'Each page becomes an image. Your edits are included.';
    inspectorBody.innerHTML = `
      <div class="field"><label>Format</label>
        <select id="img-format"><option value="png" selected>PNG (lossless)</option><option value="jpeg">JPG (smaller files)</option></select>
      </div>
      <div class="field"><label>Resolution</label>
        <select id="img-dpi"><option value="96">Screen (96 DPI)</option><option value="150" selected>Standard (150 DPI)</option><option value="300">Print (300 DPI)</option></select>
      </div>
      <button class="btn btn-primary btn-block" id="img-apply" type="button">Export images</button>
    `;
    $('#img-apply').onclick = async () => {
      const format = $('#img-format').value, dpi = Number($('#img-dpi').value);
      PDFUtils.setStatus(canPickDir() ? 'Choose a folder to save into…' : 'Rendering pages…');
      try {
        const n = await saveMany(async () => {
          PDFUtils.setStatus('Rendering pages…');
          const src = await currentLoaded();
          const results = await PDFEngine.toImages(src, { format, dpi });
          return results.map(r => ({ name: r.name, blob: r.blob }));
        });
        PDFUtils.setStatus(n ? `${n} images saved.` : '', n ? 'success' : undefined);
      } catch (e) { console.error(e); PDFUtils.setStatus('Export failed.', 'error'); }
    };
  }

  function inspDownload() {
    const count = state.annotations.length;
    inspectorTitle.textContent = 'Apply changes & save';
    inspectorHint.textContent = count
      ? `Bakes ${count} edit(s) and any rotations into a new PDF.`
      : 'Saves the PDF with any rotations applied. Tip: the big "Apply Changes" button at the bottom does this too.';
    inspectorBody.innerHTML = `<button class="btn btn-primary btn-block" id="dl-apply" type="button">Apply changes &amp; save</button>`;
    $('#dl-apply').onclick = async () => {
      PDFUtils.setStatus('Saving…');
      const res = await saveBytes(() => currentBytes(), `${PDFEngine.stripExt(state.loaded.name)}_edited.pdf`);
      if (res === 'saved') PDFUtils.setStatus('Saved.', 'success');
      else if (res === 'cancelled') PDFUtils.setStatus('');
      else PDFUtils.setStatus('Save failed.', 'error');
    };
  }

  // ---------- Range parsing ----------
  function parseRange(str, max) {
    const out = new Set();
    for (const p of str.split(/[,\s]+/).filter(Boolean)) {
      const m = p.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) return [];
      const start = Math.max(1, Math.min(max, Number(m[1])));
      const end = m[2] ? Math.max(1, Math.min(max, Number(m[2]))) : start;
      const [lo, hi] = [Math.min(start, end), Math.max(start, end)];
      for (let i = lo; i <= hi; i++) out.add(i - 1);
    }
    return Array.from(out).sort((a, b) => a - b);
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));

  // ---------- Signature pad ----------
  let sigCtx, sigDrawing = false, sigHasInk = false, sigImage = null;
  function setupSigPad() {
    const pad = $('#sig-pad');
    if (!pad) return;
    pad.width = pad.offsetWidth * (window.devicePixelRatio || 1);
    pad.height = pad.offsetHeight * (window.devicePixelRatio || 1);
    sigCtx = pad.getContext('2d');
    sigCtx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
    sigCtx.lineWidth = 2.2; sigCtx.lineCap = 'round'; sigCtx.lineJoin = 'round'; sigCtx.strokeStyle = '#000';
    sigHasInk = false; sigImage = null;
    const pos = e => {
      const r = pad.getBoundingClientRect();
      return { x: (e.touches ? e.touches[0].clientX : e.clientX) - r.left, y: (e.touches ? e.touches[0].clientY : e.clientY) - r.top };
    };
    pad.addEventListener('pointerdown', e => { sigDrawing = true; sigHasInk = true; const p = pos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y); });
    pad.addEventListener('pointermove', e => { if (!sigDrawing) return; const p = pos(e); sigCtx.lineTo(p.x, p.y); sigCtx.stroke(); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => pad.addEventListener(ev, () => { sigDrawing = false; }));
  }
  function clearSig() {
    const pad = $('#sig-pad');
    if (sigCtx && pad) sigCtx.clearRect(0, 0, pad.width, pad.height);
    sigHasInk = false; sigImage = null;
  }
  sigInput.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const bytes = await file.arrayBuffer();
    sigImage = { bytes, mime: file.type, dataUrl: await blobToDataUrl(file) };
    PDFUtils.setStatus('Signature image loaded — now click “Use this signature”.', 'success');
    sigInput.value = '';
  });
  async function useSignature() {
    let imageBytes, mime, dataUrl, aspect;
    if (sigImage) {
      imageBytes = sigImage.bytes; mime = sigImage.mime; dataUrl = sigImage.dataUrl;
      aspect = await imgAspect(dataUrl);
    } else if (sigHasInk) {
      const pad = $('#sig-pad');
      const blob = await new Promise(r => pad.toBlob(r, 'image/png'));
      imageBytes = await blob.arrayBuffer(); mime = 'image/png';
      dataUrl = await blobToDataUrl(blob);
      aspect = pad.width / pad.height;
    } else { PDFUtils.setStatus('Draw a signature or upload an image first.', 'error'); return; }
    state.pendingSignature = { imageBytes, mime, dataUrl, aspect: aspect || 3 };
    PDFUtils.setStatus('Signature ready — click on the page to place it.', 'success');
    showInspector('sign');
  }
  function blobToDataUrl(blob) {
    return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
  }
  function imgAspect(src) {
    return new Promise(res => { const i = new Image(); i.onload = () => res(i.width / i.height); i.onerror = () => res(3); i.src = src; });
  }

})();

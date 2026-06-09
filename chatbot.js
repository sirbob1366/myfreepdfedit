/* ===========================================================
   chatbot.js — Lightweight FAQ help widget (all pages)
   -----------------------------------------------------------
   Rule-based, offline. Answers only tool-usage / how-to / support
   questions. No external AI, no backend, no data leaves the page.
   =========================================================== */

(function () {
  'use strict';

  // Curated FAQ. `k` = keywords used for matching (lowercase).
  const FAQ = [
    { id: 'start', q: 'How do I use the editor?',
      k: ['use', 'editor', 'start', 'begin', 'how do i', 'get started', 'how to use'],
      a: 'Open the <a href="/editor/">editor</a> and drop in a PDF. Pick a tool on the left (Add text, Edit text, Signature, Redact, Comment, Crop, Rotate, Split, Compress…), make your changes right on the page, then click the big <strong>Apply Changes</strong> button to save.' },
    { id: 'addtext', q: 'How do I add text?',
      k: ['add text', 'type', 'write', 'insert text', 'new text'],
      a: 'Choose <strong>Add text</strong>, click anywhere on the page, and start typing. Use the inspector on the right to set font, size, colour, bold/italic/underline, or insert symbols. Drag the grip to move it.' },
    { id: 'edittext', q: 'How do I edit or delete existing text?',
      k: ['edit text', 'edit existing', 'change text', 'delete text', 'remove text', 'existing'],
      a: 'Choose <strong>Edit existing text</strong>. Editable text is highlighted — click a line, then change the words or clear it to remove. The original is covered with white. (Browser PDF editors replace text this way since the original glyphs can\'t be altered in place.)' },
    { id: 'sign', q: 'How do I sign a PDF?',
      k: ['sign', 'signature', 'esign', 'autograph'],
      a: 'Choose <strong>Signature</strong>, draw it with your mouse/finger or upload an image, click “Use this signature”, then click on the page to place it. Drag to move, drag the corner to resize.' },
    { id: 'comment', q: 'How do I add a comment?',
      k: ['comment', 'note', 'sticky', 'annotation'],
      a: 'Choose <strong>Comment</strong>, click where you want the note, and type. It is saved as a real PDF sticky note that shows up in the comments pane of Preview or Acrobat.' },
    { id: 'redact', q: 'How do I redact / black out content?',
      k: ['redact', 'black out', 'hide', 'censor', 'cover'],
      a: 'Choose <strong>Redact</strong> and drag a rectangle over anything you want to black out. Note: this covers the content visually — for sensitive data, treat it as a visual cover.' },
    { id: 'crop', q: 'How do I crop a page?',
      k: ['crop', 'trim', 'cut', 'margins'],
      a: 'Choose <strong>Crop</strong>, drag a rectangle to set the area to keep, then drag/resize the box to adjust. Tick “Apply to all pages” to crop the whole document. Saving applies it as the PDF crop box.' },
    { id: 'merge', q: 'How do I merge PDFs?',
      k: ['merge', 'combine', 'join', 'add pdf'],
      a: 'In the editor use <strong>Add PDF (merge)</strong> to append another file, or use the dedicated <a href="/merge-pdf/">Merge PDF</a> tool to combine several and reorder them.' },
    { id: 'split', q: 'How do I split or extract pages?',
      k: ['split', 'extract', 'separate', 'pages', 'delete page'],
      a: 'Use <strong>Split / Extract</strong> in the editor: select pages in the rail or type a range (e.g. 1-3, 5), then extract — or split into single pages. <strong>Delete pages</strong> removes selected ones.' },
    { id: 'rotate', q: 'How do I rotate pages?',
      k: ['rotate', 'turn', 'orientation', 'sideways', 'upside'],
      a: 'Choose <strong>Rotate</strong> and use 90° left/right or 180°. It rotates the current page, or select pages in the rail to rotate several. Rotation shows live and is included when you save.' },
    { id: 'compress', q: 'How do I compress / reduce file size?',
      k: ['compress', 'reduce', 'smaller', 'size', 'shrink'],
      a: 'Choose <strong>Compress</strong>, pick a level (low/medium/high), and apply. Or use the <a href="/compress-pdf/">Compress PDF</a> tool.' },
    { id: 'convert', q: 'Can I convert to images or Word?',
      k: ['convert', 'image', 'jpg', 'png', 'word', 'docx', 'to images'],
      a: 'Yes — use <strong>To Images</strong> in the editor (PNG/JPG per page), the <a href="/pdf-to-image/">PDF to Image</a> tool, or <a href="/pdf-to-word/">PDF to Word</a>.' },
    { id: 'math', q: 'Does it support math / special symbols?',
      k: ['math', 'symbol', 'special', 'equation', 'pi', 'sigma', 'greek', 'fraction'],
      a: 'Yes. With the text tool, use the <strong>Insert symbol</strong> palette for × ÷ ± ≤ ≥ ≠ √ π ∑ ∫ and more. Symbols are rendered with a Unicode font automatically so they export correctly.' },
    { id: 'save', q: 'How do I save / choose where it downloads?',
      k: ['save', 'download', 'export', 'where', 'location', 'folder', 'apply changes'],
      a: 'Click <strong>Apply Changes</strong> (or a tool\'s save button). On Chrome/Edge you get a dialog to choose the folder and name; on Safari/Firefox/mobile it downloads to your default folder.' },
    { id: 'free', q: 'Is it free?',
      k: ['free', 'cost', 'price', 'pay', 'subscription', 'watermark'],
      a: 'Yes — every tool is free, with no signup, no watermark and no file-count limits. The site is supported by unobtrusive ads.' },
    { id: 'privacy', q: 'Are my files uploaded?',
      k: ['upload', 'privacy', 'private', 'secure', 'server', 'safe', 'data'],
      a: 'For the editor and most tools, your file is processed entirely in your browser and never uploaded. See our <a href="/privacy/">Privacy Policy</a>. A few conversion tools may use server processing — that\'s stated on the tool page.' },
    { id: 'browsers', q: 'What browsers / devices work?',
      k: ['browser', 'safari', 'chrome', 'edge', 'firefox', 'mobile', 'iphone', 'android', 'ipad', 'mac', 'windows'],
      a: 'It works in modern Chrome, Edge, Safari and Firefox on Windows and Mac, plus iOS and Android. Nothing to install.' },
    { id: 'size', q: 'Is there a file size limit?',
      k: ['size limit', 'how big', 'large file', 'maximum', 'limit'],
      a: 'No hard limit, but very large files (500 MB+) may be slow depending on your device. Under ~200 MB works best.' }
  ];

  const GREETING = "Hi! I can help with how to use the PDF tools. Pick a question or type one below.";
  const SUGGESTED = ['start', 'addtext', 'edittext', 'sign', 'merge', 'crop'];

  function norm(s) { return (s || '').toLowerCase().replace(/[^\w\s±×÷≤≥≠≈√π∑∫]/g, ' '); }

  function bestMatch(input) {
    const q = norm(input);
    if (!q.trim()) return null;
    let best = null, score = 0;
    for (const f of FAQ) {
      let s = 0;
      for (const kw of f.k) if (q.includes(kw)) s += kw.includes(' ') ? 2 : 1;
      if (s > score) { score = s; best = f; }
    }
    return score > 0 ? best : null;
  }

  // ---------- UI ----------
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  let panel, log, openBtn;

  function build() {
    openBtn = el('button', 'cb-fab');
    openBtn.type = 'button';
    openBtn.setAttribute('aria-label', 'Help');
    openBtn.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z" stroke-linejoin="round"/><path d="M9 9h7M9 12h5" stroke-linecap="round"/></svg>';
    openBtn.onclick = toggle;
    document.body.appendChild(openBtn);

    panel = el('div', 'cb-panel');
    panel.hidden = true;
    panel.innerHTML = `
      <div class="cb-head">
        <span>Help &amp; FAQ</span>
        <button type="button" class="cb-close" aria-label="Close">&times;</button>
      </div>
      <div class="cb-log" id="cb-log"></div>
      <form class="cb-input" id="cb-form">
        <input type="text" id="cb-text" placeholder="Ask how to use a tool…" autocomplete="off" />
        <button type="submit" aria-label="Send">→</button>
      </form>`;
    document.body.appendChild(panel);
    log = panel.querySelector('#cb-log');
    panel.querySelector('.cb-close').onclick = toggle;
    panel.querySelector('#cb-form').addEventListener('submit', e => {
      e.preventDefault();
      const inp = panel.querySelector('#cb-text');
      const v = inp.value.trim();
      if (!v) return;
      ask(v);
      inp.value = '';
    });
  }

  function addMsg(who, html) {
    const m = el('div', 'cb-msg cb-' + who, html);
    log.appendChild(m);
    log.scrollTop = log.scrollHeight;
    return m;
  }

  function chips(ids) {
    const wrap = el('div', 'cb-chips');
    ids.forEach(id => {
      const f = FAQ.find(x => x.id === id);
      if (!f) return;
      const c = el('button', 'cb-chip', esc(f.q));
      c.type = 'button';
      c.onclick = () => { addMsg('user', esc(f.q)); answer(f); };
      wrap.appendChild(c);
    });
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
  }

  function answer(f) { addMsg('bot', f.a); }

  function ask(text) {
    addMsg('user', esc(text));
    const m = bestMatch(text);
    if (m) answer(m);
    else {
      addMsg('bot', "I can only help with using the PDF tools — like adding text, signing, merging, cropping, or saving. Try one of these:");
      chips(['start', 'addtext', 'sign', 'merge', 'convert', 'privacy']);
    }
  }

  let started = false;
  function toggle() {
    panel.hidden = !panel.hidden;
    openBtn.classList.toggle('cb-open', !panel.hidden);
    if (!panel.hidden && !started) {
      started = true;
      addMsg('bot', GREETING);
      chips(SUGGESTED);
    }
    if (!panel.hidden) panel.querySelector('#cb-text').focus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();

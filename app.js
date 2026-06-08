/* Shared JS — theme toggle, footer year, utility helpers */

(function () {
  // ---------- Theme ----------
  const root = document.documentElement;
  const stored = localStorage.getItem('theme');
  if (stored === 'dark' || stored === 'light') {
    root.setAttribute('data-theme', stored);
  }
  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const currentExplicit = root.getAttribute('data-theme');
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const currentEffective = currentExplicit || (systemDark ? 'dark' : 'light');
      const next = currentEffective === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
    });
  }

  // ---------- Footer year ----------
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();
})();

/* Exposed helpers for tool pages */
window.PDFUtils = {
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
  },

  download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  setStatus(msg, type) {
    const el = document.querySelector('.status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.remove('error', 'success');
    if (type) el.classList.add(type);
  }
};

/* ===========================================================
   auth.js — Supabase auth UI (injected on every page)
   -----------------------------------------------------------
   Loaded by app.js ONLY when supabase-config.js is filled in and the
   Supabase JS client is present. Provides:
     • a "Sign in" control in the nav (becomes a user chip when signed in)
     • a login modal with Google / Discord / Facebook
     • session handling + a small account menu
   Files are never uploaded — accounts only carry profile/session.
   Exposes window.Auth = { client, user, signIn, signOut, openModal }.
   =========================================================== */

(function () {
  'use strict';

  const cfg = window.SUPABASE_CONFIG;
  if (!cfg || !cfg.url || !cfg.anonKey || !window.supabase) return;

  const client = window.supabase.createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const PROVIDERS = [
    { id: 'google', label: 'Continue with Google',
      svg: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M23 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.2a5.3 5.3 0 0 1-2.3 3.5v2.9h3.7C21.8 18.9 23 15.9 23 12.3z"/><path fill="#34A853" d="M12 24c3.1 0 5.7-1 7.6-2.8l-3.7-2.9c-1 .7-2.3 1.1-3.9 1.1-3 0-5.5-2-6.4-4.8H1.8v3C3.7 21.4 7.6 24 12 24z"/><path fill="#FBBC05" d="M5.6 14.6a7.2 7.2 0 0 1 0-4.6v-3H1.8a12 12 0 0 0 0 10.6l3.8-3z"/><path fill="#EA4335" d="M12 4.8c1.7 0 3.2.6 4.4 1.7l3.3-3.3C17.7 1.2 15.1 0 12 0 7.6 0 3.7 2.6 1.8 6.4l3.8 3C6.5 6.7 9 4.8 12 4.8z"/></svg>' },
    { id: 'discord', label: 'Continue with Discord',
      svg: '<svg viewBox="0 0 24 24" width="18" height="18" fill="#5865F2"><path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.3.5a18 18 0 0 1 4.3 1.4 16.6 16.6 0 0 0-14.9 0A18 18 0 0 1 8.8 3.5L8.6 3a19.8 19.8 0 0 0-5 1.4C.6 9 .1 13.5.3 17.9A19.9 19.9 0 0 0 6.4 21l.4-.7c-.7-.2-1.3-.5-1.9-.9l.5-.3a14.2 14.2 0 0 0 12.2 0l.5.3c-.6.4-1.2.7-1.9.9l.4.7a19.9 19.9 0 0 0 6.1-3.1c.3-5-.6-9.5-2.9-12.5zM8.5 15.3c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2zm7 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2z"/></svg>' },
    { id: 'facebook', label: 'Continue with Facebook',
      svg: '<svg viewBox="0 0 24 24" width="18" height="18" fill="#1877F2"><path d="M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.2c-1.2 0-1.6.8-1.6 1.5V12h2.7l-.4 2.9h-2.3v7A10 10 0 0 0 22 12z"/></svg>' }
  ];

  const state = { user: null };

  // ---------- Nav control ----------
  function navLinks() { return document.querySelector('.nav-links'); }

  function renderNav() {
    const nav = navLinks();
    if (!nav) return;
    let mount = nav.querySelector('.auth-control');
    if (!mount) {
      mount = document.createElement('div');
      mount.className = 'auth-control';
      const toggle = nav.querySelector('.theme-toggle');
      nav.insertBefore(mount, toggle || null);
    }
    if (state.user) {
      const name = displayName(state.user);
      const avatar = state.user.user_metadata && state.user.user_metadata.avatar_url;
      mount.innerHTML = `
        <button class="auth-chip" type="button" aria-haspopup="true">
          ${avatar ? `<img src="${avatar}" alt="" referrerpolicy="no-referrer" />`
                   : `<span class="auth-initial">${escapeHtml(initial(name))}</span>`}
          <span class="auth-name">${escapeHtml(name)}</span>
        </button>
        <div class="auth-menu" hidden>
          <a href="/account/">Account</a>
          <button type="button" class="auth-signout">Sign out</button>
        </div>`;
      const chip = mount.querySelector('.auth-chip');
      const menu = mount.querySelector('.auth-menu');
      chip.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
      mount.querySelector('.auth-signout').onclick = signOut;
      document.addEventListener('click', () => { if (menu) menu.hidden = true; }, { once: true });
    } else {
      mount.innerHTML = `<button class="auth-signin" type="button">Sign in</button>`;
      mount.querySelector('.auth-signin').onclick = openModal;
    }
  }

  // ---------- Login modal ----------
  function ensureModal() {
    let m = document.getElementById('auth-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'auth-modal';
    m.className = 'auth-modal';
    m.hidden = true;
    m.innerHTML = `
      <div class="auth-modal-backdrop" data-close></div>
      <div class="auth-modal-card" role="dialog" aria-modal="true" aria-label="Sign in">
        <button class="auth-modal-x" type="button" data-close aria-label="Close">&times;</button>
        <h2>Sign in to MyFreePDFEdit</h2>
        <p class="auth-modal-sub">Save your preferences across devices. Your PDFs stay on your device — accounts never store your files.</p>
        <div class="auth-providers">
          ${PROVIDERS.map(p => `<button type="button" class="auth-provider" data-provider="${p.id}">${p.svg}<span>${p.label}</span></button>`).join('')}
        </div>
        <p class="auth-modal-fine">By continuing you agree to our <a href="/terms/">Terms</a> and <a href="/privacy/">Privacy Policy</a>.</p>
      </div>`;
    document.body.appendChild(m);
    m.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeModal));
    m.querySelectorAll('.auth-provider').forEach(btn =>
      btn.addEventListener('click', () => signIn(btn.dataset.provider)));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
    return m;
  }
  function openModal() { ensureModal().hidden = false; }
  function closeModal() { const m = document.getElementById('auth-modal'); if (m) m.hidden = true; }

  // ---------- Auth actions ----------
  async function signIn(provider) {
    try {
      const { error } = await client.auth.signInWithOAuth({
        provider,
        options: { redirectTo: window.location.origin + window.location.pathname }
      });
      if (error) throw error;
      // browser redirects to the provider…
    } catch (e) {
      console.error('Sign-in failed', e);
      alert('Sign-in failed: ' + (e && e.message ? e.message : 'unknown error'));
    }
  }
  async function signOut() {
    try { await client.auth.signOut(); } catch (e) { console.error(e); }
    state.user = null;
    renderNav();
    if (location.pathname.startsWith('/account')) location.href = '/';
  }

  // ---------- Helpers ----------
  function displayName(u) {
    const m = u.user_metadata || {};
    return m.full_name || m.name || m.user_name || (u.email ? u.email.split('@')[0] : 'Account');
  }
  function initial(name) { return (name || '?').trim().charAt(0).toUpperCase() || '?'; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Boot ----------
  client.auth.getSession().then(({ data }) => {
    state.user = data.session ? data.session.user : null;
    renderNav();
    document.dispatchEvent(new CustomEvent('auth:ready', { detail: { user: state.user } }));
  });
  client.auth.onAuthStateChange((_event, session) => {
    state.user = session ? session.user : null;
    renderNav();
    closeModal();
    document.dispatchEvent(new CustomEvent('auth:change', { detail: { user: state.user } }));
  });

  window.Auth = {
    client,
    get user() { return state.user; },
    signIn, signOut, openModal, displayName
  };
})();

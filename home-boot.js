/* ===========================================================
   home-boot.js — decides which homepage mode to run and
   lazy-loads the 3D stack after first paint.

   Modes (class on <html>):
     js3d     — full scroll-driven 3D experience (desktop)
     m-simple — simplified 3D (mobile: hero + deconstruction only)
     static3d — no WebGL: static technical layout w/ SVG hero
   With JS disabled none of these classes exist and the page is
   a plain, fully crawlable document.
   =========================================================== */

(function () {
  'use strict';

  var html = document.documentElement;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var mobile = window.innerWidth < 768;

  function webglOK() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (e) { return false; }
  }

  if (reduced || !webglOK()) {
    html.classList.add('static3d');
    return;
  }

  function toStatic() {
    html.classList.remove('js3d', 'm-simple');
    html.classList.add('static3d');
    if (window.ScrollTrigger) try { window.ScrollTrigger.killAll(); } catch (e) {}
    window.scrollTo(0, 0);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('failed: ' + src)); };
      document.head.appendChild(s);
    });
  }

  function startEngine() {
    loadScript('/vendor/gsap/gsap.min.js')
      .then(function () { return loadScript('/vendor/gsap/ScrollTrigger.min.js'); })
      .then(function () { return import('/home3d.js'); })
      .then(function (mod) {
        html.classList.add(mobile ? 'm-simple' : 'js3d');
        mod.start({ simple: mobile, onFallback: toStatic });
      })
      .catch(function (err) {
        console.warn('3D experience unavailable:', err);
        toStatic();
      });
  }

  // Lazy: wait for full load, then an idle slot — the static page is
  // already painted and interactive long before the scene exists.
  function schedule() {
    (window.requestIdleCallback || function (f) { setTimeout(f, 200); })(startEngine);
  }
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule);
})();

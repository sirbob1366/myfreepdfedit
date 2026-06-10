/* ===========================================================
   qpdf-engine.js — Browser wrapper around the self-hosted
   qpdf WebAssembly build (vendor/qpdf/qpdf.js + qpdf.wasm).
   Used by /protect-pdf/ and /unlock-pdf/. See README.md here
   for integration notes.
   =========================================================== */

(function () {
  'use strict';

  let scriptPromise = null;

  function loadScript() {
    if (!scriptPromise) {
      scriptPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/vendor/qpdf/qpdf.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load qpdf.js'));
        document.head.appendChild(s);
      });
    }
    return scriptPromise;
  }

  // Fresh instance per operation — callMain is not reliably re-entrant
  // after the Emscripten runtime exits.
  async function createInstance(stderrLines) {
    await loadScript();
    const factory = window.Module; // MODULARIZE factory defined by qpdf.js
    if (typeof factory !== 'function') throw new Error('qpdf module factory not found');
    return factory({
      noInitialRun: true,
      print: () => {},
      printErr: s => stderrLines.push(s),
      locateFile: p => '/vendor/qpdf/' + p
    });
  }

  // Run qpdf over input bytes; resolves with output bytes (Uint8Array).
  // Rejects with qpdf's stderr message on a nonzero exit.
  async function run(args, inputBytes) {
    const stderr = [];
    const mod = await createInstance(stderr);
    mod.FS.writeFile('/in.pdf', new Uint8Array(inputBytes));
    let code = 0;
    try { code = mod.callMain(args) || 0; }
    catch (e) { code = (e && e.status) != null ? e.status : 1; }
    if (code !== 0) {
      const err = new Error(stderr.join('\n') || 'qpdf failed with exit code ' + code);
      err.code = code;
      err.invalidPassword = /invalid password/i.test(stderr.join('\n'));
      throw err;
    }
    return mod.FS.readFile('/out.pdf');
  }

  window.QPDF = {
    // AES-256 encryption. userPw opens the document; ownerPw controls
    // permission changes (falls back to userPw when omitted).
    encrypt(bytes, userPw, ownerPw) {
      return run(['--encrypt', userPw, ownerPw || userPw, '256', '--', '/in.pdf', '/out.pdf'], bytes);
    },

    // Remove encryption. Requires the correct password — this is not,
    // and will never be, a password cracker.
    decrypt(bytes, password) {
      const args = password
        ? ['--password=' + password, '--decrypt', '/in.pdf', '/out.pdf']
        : ['--decrypt', '/in.pdf', '/out.pdf'];
      return run(args, bytes);
    }
  };
})();

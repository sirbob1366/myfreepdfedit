# qpdf WebAssembly (self-hosted)

pdf-lib cannot add or remove PDF encryption, so `/protect-pdf/` and `/unlock-pdf/`
use [qpdf](https://github.com/qpdf/qpdf) compiled to WebAssembly.

## Files

| File | What it is | Source |
|---|---|---|
| `qpdf.js` | Emscripten MODULARIZE glue (defines a global `Module` factory) | `@jspawn/qpdf-wasm@0.0.2` npm package (Apache-2.0) |
| `qpdf.wasm` | qpdf compiled to wasm (~1.2 MB) | same package |
| `qpdf-engine.js` | Our wrapper exposing `window.QPDF.encrypt/decrypt` | written for this site |

## Integration notes (verified 2026-06)

- The glue is a classic script, not an ES module. Loading it defines a global
  `Module` **factory function** (MODULARIZE build). Call it with a config object;
  it returns a promise of the instantiated module.
- This particular build **strips `wasmBinary` support** — you cannot pass wasm
  bytes directly. It locates `qpdf.wasm` relative to the script URL, overridable
  via `locateFile`. Our wrapper pins it to `/vendor/qpdf/qpdf.wasm`.
  (For Node tests, use the `instantiateWasm` hook instead, since Node's `fetch`
  cannot load plain file paths.)
- Pass `noInitialRun: true` and drive it with `mod.callMain([...argv])`,
  using `mod.FS.writeFile / readFile` for I/O (in-memory FS, nothing persists).
- Create a **fresh instance per operation**: after `callMain` the Emscripten
  runtime may exit and a second `callMain` on the same instance is unreliable.
- Errors: qpdf exits nonzero and prints to stderr (`printErr`). A wrong password
  exits with code 2 and the message `…: invalid password`.

## Commands used

```
# AES-256 encrypt (user password opens the file, owner password controls permissions)
qpdf --encrypt <userPw> <ownerPw> 256 -- in.pdf out.pdf

# Remove encryption, given the correct password
qpdf --password=<pw> --decrypt in.pdf out.pdf
```

## Smoke test

A Node round-trip (generate `--empty` → encrypt → decrypt → wrong-password
rejection) was run against these exact files when they were vendored:
all four steps behaved correctly. Re-run it if you bump the package version.

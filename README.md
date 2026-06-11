# MyFreePDFEdit

Free in-browser PDF toolkit. Apple Preview-inspired UI. Privacy-first (most tools run client-side).

## What's in this v0

- **Homepage** — hero, 8 tool tiles, "how it works", FAQ, footer
- **Merge PDF** — fully working, client-side, with drag-to-reorder
- **SEO foundation** — meta tags, OG/Twitter cards, JSON-LD schema, sitemap.xml, robots.txt
- **Theming** — light/dark with system preference detection + manual toggle, persisted

Stack: vanilla HTML/CSS/JS + `pdf-lib` via CDN. No build step. Drop on any static host.

## Homepage 3D experience (2026-06)

The homepage is a scroll-driven Three.js scene ("TECHNICAL DOCUMENT" direction):
camera travels a CatmullRom path through five chapters (arrival → exploded
document anatomy → tool workbenches → vault promise → plain-DOM tool index).

- `home-boot.js` decides the mode (full 3D / mobile-simplified / static) and
  lazy-loads `/vendor/three/` + `/vendor/gsap/` (789KB total) after first paint.
- `home3d.js` is the scene + choreography. Tune the camera with `/?DEBUG=1`
  (waypoint editor, FPS, `c` captures a PNG frame — use it to regenerate the
  static hero in `/assets/`).
- **Static-first**: with JS disabled the page is a complete crawlable document
  (h1, 17-tool index, FAQ + FAQPage JSON-LD, footer). Reduced-motion, no-WebGL,
  or sustained <30fps on mobile fall back to the static layout with the
  blueprint SVG hero.
- Tool pages echo the language in pure CSS (vellum grid, precision-red accent,
  monospace annotations) — zero WebGL outside the homepage.

## Run locally

```bash
cd myfreepdfedit
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy to Cloudflare Pages (free)

1. Push this folder to a new GitHub repo
2. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git
3. Pick the repo, leave build command empty, set output directory to `/`
4. Deploy. You'll get a `*.pages.dev` URL
5. Custom domain → add `myfreepdfedit.com` and follow the DNS instructions

## Post-deploy checklist (per the video's playbook)

- [ ] Connect `myfreepdfedit.com` in Cloudflare
- [ ] Submit `https://myfreepdfedit.com/sitemap.xml` to Google Search Console
- [ ] Submit to Bing Webmaster Tools
- [ ] Add Google Analytics 4 tracking ID to `app.js` (or directly in `<head>`)
- [ ] Create `/privacy/`, `/terms/`, `/about/`, `/contact/` pages — **required for AdSense approval**
- [ ] Wait until you have ~20-30 indexed pages and some traffic, then apply for AdSense
- [ ] Block the `*.pages.dev` URL in robots so you don't get duplicate-content penalized

## Tools

Original nine: Merge, Split, Compress, Rotate, PDF→Image, Sign, Edit (unified `/editor/`), PDF→Word, plus the homepage.

2026-06 expansion (all client-side, each with its own SEO page; watermark, page
numbers, protect, OCR and form detection are also inside `/editor/`):

- **/jpg-to-pdf/** — JPG/PNG/WebP → PDF; reorder, page size, orientation, margins (pdf-lib; WebP transcoded via canvas)
- **/organize-pdf/** — visual page manager: drag-reorder, rotate, delete, duplicate, blank pages, insert from another PDF
- **/watermark-pdf/** — text/image, opacity, rotation, 9-zone or tiled, range; live preview
- **/page-numbers/** — position/format presets + **Bates numbering** (legal)
- **/protect-pdf/** — AES-256 encryption via self-hosted **qpdf wasm** (`/vendor/qpdf/`, see its README)
- **/unlock-pdf/** — removes encryption *given the correct password* (refuse-by-design: not a cracker)
- **/pdf-ocr/** — self-hosted **Tesseract.js** (`/vendor/tesseract/`, 11 languages incl. Hindi); rebuilds a searchable PDF on-device, no page caps
- **/fill-pdf-form/** — AcroForm filler with live overlaid inputs and flatten-on-export

New shared engine functions live in `pdf-engine.js` (`imagesToPdf`, `assemble`,
`watermark`, `addPageNumbers`); qpdf wrapper in `/vendor/qpdf/qpdf-engine.js`.

## Virality plan

- Launch on Product Hunt (Tuesday/Wednesday best)
- Post in r/pdf, r/productivity, r/sysadmin, r/legaltech with genuine use cases
- Quora answers on "free PDF merger" type questions linking to specific tool pages
- Write 3-5 blog posts targeting long-tail keywords ("how to combine 3 PDFs on Mac" etc.)
- "Made with MyFreePDFEdit" optional footer toggle on outputs

## Why no Astro?

The video recommends Astro for SEO, but the SEO benefit comes from semantic HTML, fast load times, and good meta tags — all of which we have. Astro adds a build step that complicates iteration. We can migrate later if we want a real blog, but it's not needed to rank.

## File tree

```
/
├── index.html                  # Homepage
├── styles.css                  # All styles
├── app.js                      # Shared JS (theme, helpers)
├── favicon.svg
├── robots.txt
├── sitemap.xml
├── merge-pdf/index.html        # Tool page
├── README.md
```

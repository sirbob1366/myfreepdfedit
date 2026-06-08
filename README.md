# MyFreePDFEdit

Free in-browser PDF toolkit. Apple Preview-inspired UI. Privacy-first (most tools run client-side).

## What's in this v0

- **Homepage** — hero, 8 tool tiles, "how it works", FAQ, footer
- **Merge PDF** — fully working, client-side, with drag-to-reorder
- **SEO foundation** — meta tags, OG/Twitter cards, JSON-LD schema, sitemap.xml, robots.txt
- **Theming** — light/dark with system preference detection + manual toggle, persisted

Stack: vanilla HTML/CSS/JS + `pdf-lib` via CDN. No build step. Drop on any static host.

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

## Build order for remaining tools

Recommend building in this order based on search volume and difficulty:

1. **Merge PDF** ✅ done
2. **Split PDF** — pdf-lib, similar to merge
3. **Compress PDF** — pdf-lib + image re-encoding; moderate
4. **Rotate PDF** — pdf-lib, easy
5. **PDF to Image** — pdf.js rendering to canvas
6. **Sign PDF** — pdf-lib + signature pad canvas
7. **Edit PDF (annotate)** — pdf.js + pdf-lib; most complex
8. **PDF to Word** — needs server (Cloudflare Worker + libreoffice OR a paid API). Save for last.

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

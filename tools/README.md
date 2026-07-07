# tools/

One-off and operational scripts: generators, migrations, data fixes, and dev
checks. These are **maintainer-only** and are **not part of the distribution** —
everything in this folder is git-ignored except this README (see the `tools/`
entry in `.gitignore`), and the folder is excluded from the Docker image.

Run them from the **repo root** so their `../` imports and asset paths resolve,
e.g. `node tools/og-gen.mjs`.

Scripts that ship with the project (currently committed here):

- `og-gen.mjs` — render the 1200×630 social-preview image (`og.png`). Re-run if
  the branding changes.
- `test-ocr.mjs` — OCR gut-check: confirms tesseract.js *can't* easily read the
  captcha/banner (a low read rate means the distortion is working). Needs the
  `tesseract.js` dev dependency, installed manually.

Anything else here (ad-hoc migrations, live-data fixes, analysis one-offs) stays
local and never syncs to git.
